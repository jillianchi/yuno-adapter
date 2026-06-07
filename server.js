/**
 * Yuno → Stripe CPMT Adapter
 * 
 * Implements the reverse API contract for Stripe's merchant-instructed
 * orchestration on Checkout Sessions.
 * 
 * Supports: DuitNow (DUIT_NOW), Touch N Go (TOUCH_N_GO)
 * Merchant scenario: IHG Hotel Malaysia
 * 
 * ─── ENV VARS ───────────────────────────────────────────────────────────────
 *  STRIPE_SECRET_KEY       sk_test_...
 *  STRIPE_SIGNING_KEY      whsec_... (from Dashboard → Developers → Webhooks)
 *  YUNO_ACCOUNT_ID         532b1088-f015-4f31-843d-01117bb7ae72
 *  YUNO_PRIVATE_KEY        your Yuno private-secret-key
 *  YUNO_PUBLIC_KEY         your Yuno public-api-key
 *  YUNO_BASE_URL           https://api-sandbox.y.uno (or https://api.y.uno for prod)
 *  ADAPTER_BASE_URL        https://YOUR_APP.onrender.com (no trailing slash)
 *  PORT                    8080 (default)
 * ────────────────────────────────────────────────────────────────────────────
 * 
 * ─── ENDPOINTS ──────────────────────────────────────────────────────────────
 *  POST /yuno/payments     Stripe calls this when customer selects CPMT
 *  GET  /yuno/return       Yuno redirects customer here after payment
 *  POST /yuno/webhook      Yuno async payment notifications
 *  GET  /monitor/health    Health check
 * ────────────────────────────────────────────────────────────────────────────
 * 
 * ─── FLOW ───────────────────────────────────────────────────────────────────
 *  1. Customer selects TNG / DuitNow in Stripe Checkout
 *  2. Stripe → POST /yuno/payments  (confirm_payment event)
 *  3. Adapter → Yuno API → creates payment → gets redirect URL
 *  4. Adapter returns { status: "requires_action", next_action: { redirect_to_url }, payment_reference }
 *  5. Stripe redirects customer to Yuno/Xendit payment page
 *  6. Customer pays → Xendit redirects → GET /yuno/return
 *  7. Adapter calls report_authorized + report_guaranteed on PAR
 *  8. Adapter fetches Stripe URL 2 (get_return_url) and redirects customer
 *  9. Stripe Checkout closes → customer lands on success_url ✅
 * ────────────────────────────────────────────────────────────────────────────
 */

process.on('uncaughtException', (err) => {
  console.error('[FATAL] Uncaught exception at startup:', err);
  process.exit(1);
});
process.on('unhandledRejection', (reason) => {
  console.error('[FATAL] Unhandled rejection at startup:', reason);
  process.exit(1);
});

const express = require('express');
const axios = require('axios');

const app = express();

// ─── Config ──────────────────────────────────────────────────────────────────
const config = {
  stripe: {
    secretKey:  process.env.STRIPE_SECRET_KEY,
    signingKey: process.env.STRIPE_SIGNING_KEY, // whsec_...
  },
  yuno: {
    accountId:  process.env.YUNO_ACCOUNT_ID  || '532b1088-f015-4f31-843d-01117bb7ae72',
    privateKey: process.env.YUNO_PRIVATE_KEY,
    publicKey:  process.env.YUNO_PUBLIC_KEY,
    baseUrl:    process.env.YUNO_BASE_URL    || 'https://api-sandbox.y.uno',
  },
  adapter: {
    baseUrl: process.env.ADAPTER_BASE_URL, // e.g. https://yuno-adapter.onrender.com
  },
  port: process.env.PORT || 8080,
};

// Yuno payment method for this adapter.
// PoC: one CPMT → TOUCH_AND_GO (DuitNow sandbox not yet available from Yuno/Chee).
// Production: create separate CPMTs per method, each pointing to a different adapter path,
// e.g. /yuno/payments/tng and /yuno/payments/duitnow, and set yunoPaymentMethod per route.
const YUNO_PAYMENT_METHOD = 'TOUCH_AND_GO';

// Raw body parser — required for Stripe signature verification
app.use(express.raw({ type: '*/*' }));

// ─── In-memory session store (replace with Redis/DB for production) ───────────
// Key: payment_attempt_record (PAR) — set on first confirm_payment, read on /yuno/return + webhook
const sessions = new Map();


// ═════════════════════════════════════════════════════════════════════════════
// POST /yuno/payments
// Stripe calls this when a customer selects a CPMT and hits Pay.
// We call Yuno, get a redirect URL, return it to Stripe.
// ═════════════════════════════════════════════════════════════════════════════
app.post('/yuno/payments', async (req, res) => {
  console.log('\n[/yuno/payments] Stripe called adapter');

  let stripePayload;
  try {
    stripePayload = JSON.parse(req.body.toString());
  } catch (e) {
    console.error('[/yuno/payments] Failed to parse body:', req.body.toString());
    return res.status(400).json({ error: 'invalid_body' });
  }
  console.log('[/yuno/payments] Stripe payload:', JSON.stringify(stripePayload, null, 2));

  const eventType = stripePayload.type || '';
  const par = stripePayload.data?.payment_attempt_record;

  // Guard: only handle confirm_payment — return current session status for anything else
  if (eventType !== 'payments.orchestration.adapter.confirm_payment') {
    console.log(`[/yuno/payments] Non-confirm event type: "${eventType}" — checking session`);
    const session = par ? sessions.get(par) : null;
    if (session) {
      console.log(`[/yuno/payments] Found session for PAR ${par}, returning guaranteed`);
      return res.status(200).json({
        status: 'guaranteed',
        payment_reference: session.yunoPaymentId,
      });
    }
    // No session found — return failed so Stripe doesn't spin forever
    console.warn(`[/yuno/payments] No session for PAR ${par} on event "${eventType}" — returning failed`);
    return res.status(200).json({
      status: 'failed',
      error_code: 'payment_not_found',
    });
  }

  // TODO (production): verify Stripe webhook signature using config.stripe.signingKey

  // Idempotency: if a session already exists for this PAR, /yuno/return or /yuno/webhook
  // already called report_guaranteed — return the stored outcome immediately.
  const existingSession = par ? sessions.get(par) : null;
  if (existingSession?.yunoPaymentId) {
    console.log(`[/yuno/payments] 2nd confirm_payment for PAR ${par}. confirmed:`, existingSession.confirmed);
    if (existingSession.confirmed) {
      return res.status(200).json({
        status: 'guaranteed',
        payment_reference: existingSession.yunoPaymentId,
      });
    } else {
      console.warn('[/yuno/payments] Yuno status not confirmed:', existingSession.yunoStatus);
      return res.status(200).json({
        status: 'failed',
        error_code: 'payment_not_confirmed',
      });
    }
  }

  // Stripe confirm_payment payload shape:
  // { id, type, livemode, context, data: { amount: { currency, value }, payment_attempt_record, return_url, customer_presence } }
  const amount               = stripePayload.data?.amount?.value;
  const currency             = stripePayload.data?.amount?.currency;
  const stripeReturnUrl      = stripePayload.data?.return_url;
  const paymentAttemptRecord = stripePayload.data?.payment_attempt_record;
  const rfcId                = stripePayload.id; // fallback if PAR is missing

  // PAR is unique per attempt — use as Yuno's merchant_order_id for correlation
  const merchantOrderId = paymentAttemptRecord || rfcId;

  const yunoPaymentMethod = YUNO_PAYMENT_METHOD;

  console.log('[/yuno/payments] Resolved:', { amount, currency, yunoPaymentMethod, merchantOrderId });

  let yunoPaymentIntent;
  try {
    const yunoBody = {
      account_id:        config.yuno.accountId,      // required in body (not just header)
      merchant_order_id: merchantOrderId,
      description:       'IHG Hotel Malaysia',
      country:           'MY',
      workflow:          'REDIRECT',                 // top-level, not inside payment_method
      amount: {
        currency: currency?.toUpperCase() || 'MYR',
        value:    amount / 100, // Stripe sends minor units (sen); Yuno expects major units (MYR)
      },
      customer_payer: {                              // required by Yuno
        first_name: 'Guest',
        last_name:  'Customer',
        email:      'guest@example.com',
        country:    'MY',
      },
      payment_method: {
        type: yunoPaymentMethod,
      },
      callback_url: `${config.adapter.baseUrl}/yuno/return?par=${encodeURIComponent(paymentAttemptRecord)}`,
      checkout: {
        webhook_url: `${config.adapter.baseUrl}/yuno/webhook`,
      },
    };

    console.log('[/yuno/payments] Calling Yuno:', JSON.stringify(yunoBody, null, 2));

    const yunoResponse = await axios.post(
      `${config.yuno.baseUrl}/v1/payments`,
      yunoBody,
      {
        headers: {
          'private-secret-key':  config.yuno.privateKey,
          'public-api-key':      config.yuno.publicKey,
          'merchant-account-id': config.yuno.accountId,
          'x-idempotency-key':   merchantOrderId,   // required by Yuno; PAR is unique per attempt
          'Content-Type':        'application/json',
        },
      }
    );

    yunoPaymentIntent = yunoResponse.data;
    console.log('[/yuno/payments] Yuno responded:', JSON.stringify(yunoPaymentIntent, null, 2));

  } catch (e) {
    console.error('[/yuno/payments] Yuno API error:', e.response?.data || e.message);
    return res.status(502).json({ error: 'upstream_error', detail: e.message });
  }

  // Extract redirect URL — primary path is wallet.redirect_url, with fallbacks for other Yuno response shapes
  const redirectUrl = yunoPaymentIntent?.payment_method?.payment_method_detail?.wallet?.redirect_url
                   || yunoPaymentIntent?.checkout?.redirect_to
                   || yunoPaymentIntent?.redirect_url;

  if (!redirectUrl) {
    console.error('[/yuno/payments] No redirect URL in Yuno response');
    return res.status(502).json({ error: 'no_redirect_url' });
  }

  const yunoPaymentId = yunoPaymentIntent.id;
  sessions.set(paymentAttemptRecord, {
    yunoPaymentId,
    stripeReturnUrl,
  });
  console.log(`[/yuno/payments] Session stored: PAR=${paymentAttemptRecord} → yunoId=${yunoPaymentId}`);
  console.log('[/yuno/payments] Returning redirect URL to Stripe:', redirectUrl);

  // Required response shape — all three fields are required by Stripe:
  //   status:            "requires_action" | "guaranteed" | "failed"
  //   next_action.type:  "redirect_to_url" (not "redirect_url")
  //   payment_reference: stable ID for this payment (echoed back in future calls)
  res.status(200).json({
    status: 'requires_action',
    next_action: {
      type: 'redirect_to_url',
      redirect_to_url: {
        url: redirectUrl,
        return_url: stripeReturnUrl,
      },
    },
    payment_reference: yunoPaymentIntent.id,
  });
});


// ═════════════════════════════════════════════════════════════════════════════
// GET /yuno/return
// Xendit redirects the customer here synchronously after payment.
//
// CPMT FLOW (no second confirm_payment — adapter drives PAR directly):
//
//   1. POST /v1/payment_attempt_records/{par}/report_authorized
//      → PAR: requires_action → authorized
//
//   2. POST /v1/payment_attempt_records/{par}/report_guaranteed
//      → PAR: authorized → guaranteed (terminal success)
//      → fires Kafka event → PaymentRecordUpdatedConsumer
//      → Checkout Session: status=complete, payment_status=paid (async, ~seconds)
//
//   3. GET /v1/payment_orchestration/get_return_url/{par}
//      → Stripe Checkout URL 2 (with redirect_pm_type + lid).
//        Fallback: stripeReturnUrl stored from the 1st confirm_payment call.
//
//   4. 302 → Stripe Checkout URL 2
//      → Checkout shows success → redirects customer to success_url ✅
//
//   On any Stripe API error: log and continue — still redirect so customer isn't stuck.
// ═════════════════════════════════════════════════════════════════════════════
app.get('/yuno/return', async (req, res) => {
  const par = req.query.par;
  console.log('\n[/yuno/return] Customer returned from Yuno/Xendit. PAR:', par);
  console.log('[/yuno/return] Full query:', req.query);

  if (!par) {
    console.error('[/yuno/return] Missing ?par= parameter');
    return res.status(400).send('<h1>Missing payment reference</h1>');
  }

  const session = sessions.get(par);
  if (!session) {
    console.error('[/yuno/return] No session found for PAR:', par);
    return res.status(400).send('<h1>Session expired or not found</h1>');
  }

  const { yunoPaymentId, stripeReturnUrl } = session;
  console.log('[/yuno/return] Session found. yunoPaymentId:', yunoPaymentId);

  // Log Yuno status for debugging — but don't gate on it.
  // Xendit redirects the customer synchronously; Yuno's own status update from Xendit is async
  // (seconds later). Yuno will show PENDING here even after a successful payment.
  try {
    const yunoStatusResp = await axios.get(
      `${config.yuno.baseUrl}/v1/payments/${yunoPaymentId}`,
      { headers: {
          'public-api-key':      config.yuno.publicKey  || '',
          'private-secret-key':  config.yuno.privateKey || '',
          'merchant-account-id': config.yuno.accountId,
        }
      }
    );
    console.log('[/yuno/return] Yuno payment status (informational):', JSON.stringify(yunoStatusResp.data, null, 2));
  } catch (e) {
    console.log('[/yuno/return] Yuno status fetch failed (non-blocking):',
      e.response?.status, e.response?.data?.message || e.message);
  }

  // Trust the Xendit redirect as the success signal and drive the PAR to guaranteed.
  const stripeHeaders = {
    'Authorization':  `Bearer ${config.stripe.secretKey}`,
    'Stripe-Version': '2025-03-31.basil; checkout_merchant_instructed_orchestration_preview=v1',
    'Content-Type':   'application/x-www-form-urlencoded',
  };

  const now = Math.floor(Date.now() / 1000);

  // PAR: requires_action → authorized
  try {
    const r = await axios.post(
      `https://api.stripe.com/v1/payment_attempt_records/${par}/report_authorized`,
      `authorized_at=${now}`,
      { headers: stripeHeaders }
    );
    console.log('[/yuno/return] ✅ report_authorized succeeded. Status:', r.status);
  } catch (e) {
    console.error('[/yuno/return] ⚠️  report_authorized failed (may already be authorized):',
      e.response?.status, JSON.stringify(e.response?.data));
  }

  // PAR: authorized → guaranteed (terminal success)
  // Fires Kafka event → Checkout Session status=complete, payment_status=paid
  try {
    const r = await axios.post(
      `https://api.stripe.com/v1/payment_attempt_records/${par}/report_guaranteed`,
      `guaranteed_at=${now}`,
      { headers: stripeHeaders }
    );
    console.log('[/yuno/return] ✅ report_guaranteed succeeded. Status:', r.status);
    session.confirmed = true;
    sessions.set(par, session);
  } catch (e) {
    console.error('[/yuno/return] ⚠️  report_guaranteed failed:',
      e.response?.status, JSON.stringify(e.response?.data));
  }

  // Fetch Stripe's redirect URL (includes correlation params that tell Checkout to check PAR state)
  let returnUrl = stripeReturnUrl; // fallback: stored from confirm_payment
  try {
    const getHeaders = { 'Authorization': stripeHeaders['Authorization'], 'Stripe-Version': stripeHeaders['Stripe-Version'] };
    const urlResp = await axios.get(
      `https://api.stripe.com/v1/payment_orchestration/get_return_url/${par}`,
      { headers: getHeaders }
    );
    const freshUrl = urlResp.data?.url;
    if (freshUrl) {
      returnUrl = freshUrl;
      console.log('[/yuno/return] Got dynamic return URL from Stripe');
    }
  } catch (e) {
    console.error('[/yuno/return] ⚠️  get_return_url failed:',
      e.response?.status, JSON.stringify(e.response?.data));
    console.log('[/yuno/return] Falling back to stored return URL');
  }

  console.log('[/yuno/return] confirmed:', session.confirmed, '| Redirecting to:', returnUrl);
  res.redirect(302, returnUrl);
});


// ═════════════════════════════════════════════════════════════════════════════
// POST /yuno/webhook
// Yuno's async notification after Xendit confirms payment.
//
// Fallback: if /yuno/return didn't fire (browser closed, network issues),
// this closes the loop and calls report_guaranteed.
// Idempotent: skips if session.confirmed already set by /yuno/return.
//
// PAR is recovered from merchant_order_id, which we set = PAR when creating
// the Yuno payment, so Yuno echoes it back here.
// ═════════════════════════════════════════════════════════════════════════════
app.post('/yuno/webhook', async (req, res) => {
  console.log('\n[/yuno/webhook] Yuno event received');
  let body;
  try {
    body = JSON.parse(req.body.toString());
  } catch {
    body = req.body.toString();
  }
  console.log('[/yuno/webhook] Full payload:', JSON.stringify(body, null, 2));

  // Acknowledge immediately — Yuno retries if we don't respond fast
  res.status(200).json({ received: true });

  const par        = body?.merchant_order_id; // set = PAR when creating the Yuno payment
  const yunoStatus = body?.payment_workflow_status
                  || body?.payment_status
                  || body?.status;

  console.log(`[/yuno/webhook] PAR: ${par} | Yuno status: ${yunoStatus}`);

  if (!par) {
    console.log('[/yuno/webhook] No merchant_order_id in payload — cannot map to PAR. Skipping.');
    return;
  }

  const session = sessions.get(par);
  if (session?.confirmed) {
    console.log('[/yuno/webhook] PAR already confirmed via /yuno/return. No action needed.');
    return;
  }

  const SUCCESS_STATUSES = ['SUCCEEDED', 'CAPTURED', 'APPROVED', 'PAID', 'COMPLETE', 'COMPLETED'];
  const FAILURE_STATUSES = ['FAILED', 'DECLINED', 'CANCELLED', 'REJECTED', 'EXPIRED', 'ERROR'];

  const stripeHeaders = {
    'Authorization':  `Bearer ${config.stripe.secretKey}`,
    'Stripe-Version': '2025-03-31.basil; checkout_merchant_instructed_orchestration_preview=v1',
    'Content-Type':   'application/x-www-form-urlencoded',
  };
  const now = Math.floor(Date.now() / 1000);

  if (SUCCESS_STATUSES.includes((yunoStatus || '').toUpperCase())) {
    console.log('[/yuno/webhook] Yuno SUCCESS received. Reporting to Stripe...');

    try {
      await axios.post(
        `https://api.stripe.com/v1/payment_attempt_records/${par}/report_authorized`,
        `authorized_at=${now}`,
        { headers: stripeHeaders }
      );
      console.log('[/yuno/webhook] ✅ report_authorized succeeded');
    } catch (e) {
      // May already be authorized from /yuno/return — log and continue
      console.log('[/yuno/webhook] report_authorized:', e.response?.status, e.response?.data?.error?.message);
    }

    try {
      await axios.post(
        `https://api.stripe.com/v1/payment_attempt_records/${par}/report_guaranteed`,
        `guaranteed_at=${now}`,
        { headers: stripeHeaders }
      );
      console.log('[/yuno/webhook] ✅ report_guaranteed succeeded — Stripe loop closed via webhook');
      if (session) { session.confirmed = true; sessions.set(par, session); }
    } catch (e) {
      console.error('[/yuno/webhook] report_guaranteed:', e.response?.status, e.response?.data?.error?.message);
    }

  } else if (FAILURE_STATUSES.includes((yunoStatus || '').toUpperCase())) {
    console.log('[/yuno/webhook] Yuno FAILURE received. Reporting to Stripe...');
    try {
      await axios.post(
        `https://api.stripe.com/v1/payment_attempt_records/${par}/report_failed`,
        `failed_at=${now}&error_code=payment_declined`,
        { headers: stripeHeaders }
      );
      console.log('[/yuno/webhook] ❌ report_failed succeeded');
    } catch (e) {
      console.error('[/yuno/webhook] report_failed:', e.response?.status, e.response?.data?.error?.message);
    }

  } else {
    // PENDING, PROCESSING etc — Yuno will send another webhook when terminal
    console.log(`[/yuno/webhook] Non-terminal status "${yunoStatus}" — waiting for next webhook`);
  }
});


// ═════════════════════════════════════════════════════════════════════════════
// Health check
// ═════════════════════════════════════════════════════════════════════════════
app.get('/monitor/health', (_req, res) => {
  res.json({ status: 'ok', adapter: 'yuno', version: '1.0.0' });
});


// ─── Start ────────────────────────────────────────────────────────────────────
app.listen(config.port, () => {
  console.log(`\n🟢 Yuno adapter running on port ${config.port}`);
  console.log(`   Adapter base URL : ${config.adapter.baseUrl || '(not set — set ADAPTER_BASE_URL)'}`);
  console.log(`   Yuno base URL    : ${config.yuno.baseUrl}`);
  console.log(`   Yuno account     : ${config.yuno.accountId}`);
  console.log(`\n   POST /yuno/payments  ← Stripe calls this`);
  console.log(`   GET  /yuno/return    ← Yuno redirects here`);
  console.log(`   POST /yuno/webhook   ← Yuno async events\n`);
});
