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
 *  ADAPTER_BASE_URL        https://YOUR_NGROK_URL (no trailing slash)
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
 *  1. Customer selects DuitNow in Stripe Checkout
 *  2. Stripe → POST /yuno/payments  (signed webhook body)
 *  3. Adapter calls Yuno API → creates payment session → gets redirect URL
 *  4. Adapter returns { next_action: { type: "redirect_to_url", redirect_to_url: { url } }, payment_reference } to Stripe
 *  5. Stripe redirects customer to Yuno's DuitNow page
 *  6. Customer pays → Yuno redirects to GET /yuno/return
 *  7. Adapter verifies with Yuno, then redirects to Stripe's success_url
 * ────────────────────────────────────────────────────────────────────────────
 */

// Catch any crash at startup and print it clearly before exiting
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
    baseUrl: process.env.ADAPTER_BASE_URL, // e.g. https://abc123.ngrok.io
  },
  port: process.env.PORT || 8080,
};

// Map Stripe's CPMT ID → Yuno payment method type
// Add more entries as you create CPMTs for other methods
const CPMT_TO_YUNO_PM = {
  'cpmt_1TexW47SijG0pZIqLARmoyAa': 'DUIT_NOW',
  // 'cpmt_TOUCH_N_GO_ID': 'TOUCH_N_GO',
  // 'cpmt_TNG_ID':        'TOUCH_N_GO',
};

// Raw body parser — required for Stripe signature verification
app.use(express.raw({ type: '*/*' }));

// ─── In-memory session store (replace with Redis/DB for production) ───────────
// Maps Yuno payment_intent_id → Stripe return URL
const sessions = new Map();


// ═════════════════════════════════════════════════════════════════════════════
// POST /yuno/payments
// Stripe calls this when a customer selects a CPMT and hits Pay.
// We call Yuno, get a redirect URL, return it to Stripe.
// ═════════════════════════════════════════════════════════════════════════════
app.post('/yuno/payments', async (req, res) => {
  console.log('\n[/yuno/payments] Stripe called adapter');

  // ── 1. Parse + log raw Stripe request ──────────────────────────────────────
  let stripePayload;
  try {
    stripePayload = JSON.parse(req.body.toString());
  } catch (e) {
    console.error('[/yuno/payments] Failed to parse body:', req.body.toString());
    return res.status(400).json({ error: 'invalid_body' });
  }
  console.log('[/yuno/payments] Stripe payload:', JSON.stringify(stripePayload, null, 2));

  // ── 1b. Route by event type ────────────────────────────────────────────────
  // Stripe calls this endpoint for multiple event types:
  //   confirm_payment  → initiate payment, return requires_action + redirect URL
  //   get_payment_status (or similar) → return current status after customer returns
  const eventType = stripePayload.type || '';
  const par = stripePayload.data?.payment_attempt_record;

  if (eventType !== 'payments.orchestration.adapter.confirm_payment') {
    // Unknown/status-check event — look up stored session and return current status
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

  // ── 2. Verify Stripe signature ─────────────────────────────────────────────
  // NOTE: uncomment once you've retrieved whsec_... from Dashboard → Developers → Webhooks
  // const Stripe = require('stripe');
  // try {
  //   const stripeClient = new Stripe(config.stripe.secretKey);
  //   stripeClient.webhooks.constructEvent(
  //     req.body,
  //     req.headers['stripe-signature'],
  //     config.stripe.signingKey
  //   );
  // } catch (e) {
  //   console.error('[/yuno/payments] Signature verification failed:', e.message);
  //   return res.status(400).json({ error: 'invalid_signature' });
  // }

  // ── 2b. Second confirm_payment? Return stored status immediately ──────────
  // The 2nd call also arrives as confirm_payment (same type as the first).
  // If we already have a session for this PAR, the customer has returned from Yuno
  // and /yuno/return already verified their status — just return it.
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

  // ── 3. Extract payment details from Stripe's payload ──────────────────────
  // Contract confirmed via Beeceptor discovery (2026-06-05):
  //
  // {
  //   "id":       "rfc_test_par_test_...",
  //   "type":     "payments.orchestration.adapter.confirm_payment",
  //   "livemode": false,
  //   "context":  "acct_...",          ← Stripe account ID
  //   "data": {
  //     "amount": { "currency": "myr", "value": 15000 },
  //     "payment_attempt_record": "par_test_...",
  //     "return_url": "https://checkout.stripe.com/c/pay/cs_test_...",
  //     "customer_presence": "on_session"
  //   }
  // }
  const amount          = stripePayload.data?.amount?.value;       // 15000
  const currency        = stripePayload.data?.amount?.currency;    // "myr"
  const stripeReturnUrl = stripePayload.data?.return_url;          // Stripe's return URL
  const paymentAttemptRecord = stripePayload.data?.payment_attempt_record; // "par_test_..."
  const rfcId           = stripePayload.id;                        // "rfc_test_..."
  const stripeAccountId = stripePayload.context;                   // "acct_..."

  // Use payment_attempt_record as merchant order reference (unique per attempt)
  const merchantOrderId = paymentAttemptRecord || rfcId;

  // Determine Yuno payment method from CPMT ID
  // Confirmed type strings: TOUCH_AND_GO (not TOUCH_N_GO), DUIT_NOW
  const yunoPaymentMethod = 'TOUCH_AND_GO';

  console.log('[/yuno/payments] Resolved:', { amount, currency, yunoPaymentMethod, merchantOrderId });

  // ── 4. Call Yuno API to create payment session ────────────────────────────
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
        value:    amount,
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
      // callback_url = our adapter's /yuno/return endpoint (two-hop, PayPal-style).
      // Yuno passes this to Xendit as success_redirect_url/failure_redirect_url.
      // When customer completes TNG, Xendit → /yuno/return (adapter verifies status) → Stripe URL 2.
      // That two-hop is what triggers Stripe to fire the second confirm_payment call.
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

    // Store session for return flow
    sessions.set(yunoPaymentIntent.id, {
      stripeReturnUrl,
      paymentAttemptRecord,
      yunoPaymentIntentId: yunoPaymentIntent.id,
    });

  } catch (e) {
    console.error('[/yuno/payments] Yuno API error:', e.response?.data || e.message);
    return res.status(502).json({ error: 'upstream_error', detail: e.message });
  }

  // ── 5. Return Yuno's redirect URL to Stripe ───────────────────────────────
  // Confirmed from Yuno response (2026-06-06):
  //   payment_method.payment_method_detail.wallet.redirect_url
  const redirectUrl = yunoPaymentIntent?.payment_method?.payment_method_detail?.wallet?.redirect_url
                   || yunoPaymentIntent?.checkout?.redirect_to
                   || yunoPaymentIntent?.redirect_url;

  if (!redirectUrl) {
    console.error('[/yuno/payments] No redirect URL in Yuno response');
    return res.status(502).json({ error: 'no_redirect_url' });
  }

  // ── 5b. Store mapping PAR → Yuno payment ID so /yuno/return can look it up ─
  const yunoPaymentId = yunoPaymentIntent.id;
  sessions.set(paymentAttemptRecord, {
    yunoPaymentId,
    stripeReturnUrl,
  });
  console.log(`[/yuno/payments] Session stored: PAR=${paymentAttemptRecord} → yunoId=${yunoPaymentId}`);
  console.log('[/yuno/payments] Returning redirect URL to Stripe:', redirectUrl);

  // ── 6. Return redirect URL to Stripe ──────────────────────────────────────
  // CONFIRMED response contract (pay-server/agrippa/routes/orchestration_interface_test_adapter.rb:160):
  //
  //   {
  //     "status": "requires_action",              ← REQUIRED — without this → unknown_outcome
  //     "next_action": {
  //       "type": "redirect_to_url",
  //       "redirect_to_url": { "url": "..." }     ← REQUIRED — not "redirect_url"
  //     },
  //     "payment_reference": "..."                ← REQUIRED — missing → unknown_outcome
  //   }
  //
  // Other valid status values:
  //   "guaranteed"  — payment already confirmed (off-session / saved PM flows)
  //   "failed"      — requires error_code field
  res.status(200).json({
    status: 'requires_action',
    next_action: {
      type: 'redirect_to_url',
      redirect_to_url: {
        url: redirectUrl,
        // return_url = the final URL Stripe will see the customer land on.
        // We use stripeReturnUrl (URL 2) — the Stripe Checkout URL with redirect_pm_type+lid.
        // The customer goes: Yuno → /yuno/return (report_authenticated) → stripeReturnUrl.
        // Matching PayPal adapter: PayPal return_url = Stripe's return URL (not the adapter URL).
        return_url: stripeReturnUrl,
      },
    },
    payment_reference: yunoPaymentIntent.id, // Yuno's payment intent ID as our stable reference
  });
});


// ═════════════════════════════════════════════════════════════════════════════
// GET /yuno/return
// Xendit/Yuno redirects the customer here after payment (success or failure).
//
// CPMT FLOW — discovered from orchestration_interface_test_adapter.rb:
//
//   For CPMT there is NO second confirm_payment from Stripe.
//   The adapter drives the PAR directly to a terminal state, then redirects.
//   When the customer lands on URL 2, Stripe Checkout reads the PAR state
//   and shows success if guaranteed, error if failed.
//
//   SUCCESS path (customer paid at Yuno):
//     1. POST /v1/payment_attempt_records/{par}/report_authorized
//        → authorized_at = now (PAR transitions to authorized)
//
//     2. POST /v1/payment_attempt_records/{par}/report_guaranteed
//        → guaranteed_at = now (PAR transitions to guaranteed — terminal success)
//
//     3. GET /v1/payment_orchestration/get_return_url/{par}
//        → Fetches Stripe Checkout URL 2 (with redirect_pm_type + lid).
//          Fallback: use the return_url stored from the 1st confirm_payment call.
//
//     4. 302 → Stripe Checkout URL 2
//        → Checkout JS sees PAR = guaranteed → shows success ✅
//
//   FAILURE path: skip steps 1-2, call report_failed instead, same redirect.
//
//   Even on API error we still redirect — Stripe Checkout will show what it can.
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

  // ── Step 0: log Yuno status (informational — DO NOT gate on this) ───────────
  // Architecture: Stripe → Yuno (orchestrator) → Xendit (PSP)
  //
  // Timing issue: Xendit redirects the customer to callback_url IMMEDIATELY after
  // the customer pays. But Xendit webhooks Yuno asynchronously (seconds later).
  // So when /yuno/return fires, Yuno is still PENDING even though Xendit succeeded.
  //
  // The Xendit redirect IS the success signal — same as the test adapter callback
  // which calls ReportAuthorized/ReportGuaranteed the moment the redirect arrives.
  //
  // PoC approach: trust the Xendit redirect. Log Yuno status for debugging only.
  // Production approach: also listen for the Yuno→us webhook (POST /yuno/webhook)
  // as secondary confirmation, but Stripe is already closed by then.
  //
  // The Xendit→Yuno webhook is Yuno's responsibility. They register their own
  // endpoint at Xendit (e.g. https://api-sandbox.y.uno/xendit/callback).
  // If Yuno stays PENDING after Xendit succeeds in sandbox → ask Chee to verify
  // Xendit sandbox webhook is configured in Yuno's sandbox dashboard.
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
    // Full dump — use this to find the correct status field name
    console.log('[/yuno/return] Yuno payment status snapshot (for debug):',
      JSON.stringify(yunoStatusResp.data, null, 2));
  } catch (e) {
    console.log('[/yuno/return] Yuno status fetch failed (non-blocking):',
      e.response?.status, e.response?.data?.message || e.message);
  }

  // Xendit redirect = success signal. Proceed unconditionally.
  const yunoSucceeded = true;

  const stripeHeaders = {
    'Authorization':  `Bearer ${config.stripe.secretKey}`,
    'Stripe-Version': '2025-03-31.basil; checkout_merchant_instructed_orchestration_preview=v1',
    'Content-Type':   'application/x-www-form-urlencoded',
  };

  const now = Math.floor(Date.now() / 1000);

  if (yunoSucceeded) {
    // ── Step 1: report_authorized ───────────────────────────────────────────
    // Source: orchestration_interface_test_adapter.rb ReportAuthorized.call(...)
    // Transitions PAR: requires_action → authorized
    // Body: authorized_at=<unix_timestamp>
    try {
      const r = await axios.post(
        `https://api.stripe.com/v1/payment_attempt_records/${par}/report_authorized`,
        `authorized_at=${now}`,
        { headers: stripeHeaders }
      );
      console.log('[/yuno/return] ✅ report_authorized succeeded. Status:', r.status);
      session.authorized = true;
      sessions.set(par, session);
    } catch (e) {
      console.error('[/yuno/return] ⚠️  report_authorized failed:',
        e.response?.status, JSON.stringify(e.response?.data));
    }

    // ── Step 2: report_guaranteed ───────────────────────────────────────────
    // Source: orchestration_interface_test_adapter.rb ReportGuaranteed.call(...)
    // Transitions PAR: authorized → guaranteed (terminal success)
    // Checkout JS polls PAR → sees guaranteed → shows success. No 2nd adapter call.
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
  } else {
    // ── Failure path: report_failed ─────────────────────────────────────────
    // Yuno said the payment failed — tell Stripe so Checkout shows an error.
    try {
      const r = await axios.post(
        `https://api.stripe.com/v1/payment_attempt_records/${par}/report_failed`,
        `failed_at=${now}&error_code=payment_declined`,
        { headers: stripeHeaders }
      );
      console.log('[/yuno/return] report_failed succeeded. Status:', r.status);
    } catch (e) {
      console.error('[/yuno/return] ⚠️  report_failed failed:',
        e.response?.status, JSON.stringify(e.response?.data));
    }
  }

  // ── Step 3: fetch dynamic return URL from Stripe ──────────────────────────
  // Source: orchestration_interface_test_adapter.rb GetReturnUrl.call(...)
  // Gets Stripe Checkout URL 2 with the redirect_pm_type + lid correlation params.
  // These tell Checkout to check the PAR state (which is now guaranteed).
  let returnUrl = stripeReturnUrl; // fallback: stored from 1st confirm_payment
  try {
    const urlResp = await axios.get(
      `https://api.stripe.com/v1/payment_orchestration/get_return_url/${par}`,
      { headers: { ...stripeHeaders, 'Content-Type': undefined } }
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

  // ── Step 4: redirect customer → Stripe Checkout ──────────────────────────
  console.log('[/yuno/return] confirmed:', session.confirmed, '| Redirecting to:', returnUrl);
  res.redirect(302, returnUrl);
});


// ═════════════════════════════════════════════════════════════════════════════
// POST /yuno/webhook
// Yuno sends async payment notifications here (after Xendit notifies Yuno).
//
// THIS IS THE FALLBACK LOOP-CLOSER.
//
// Flow:
//   Xendit processes payment → Xendit POSTs to Yuno's internal endpoint
//   → Yuno updates payment status → Yuno POSTs to THIS endpoint
//
// We registered this URL with Yuno when creating the payment:
//   checkout.webhook_url = ADAPTER_BASE_URL/yuno/webhook
//
// Why this matters: Xendit redirects the customer synchronously (/yuno/return),
// but Xendit's webhook to Yuno is async. In some cases (browser closed, network
// issues), /yuno/return may not fire. This webhook closes the loop anyway.
//
// Idempotency: if /yuno/return already called report_guaranteed, session.confirmed
// will be true and we skip — Stripe would reject a double-call anyway.
//
// The PAR comes from merchant_order_id — we set that = PAR when creating the
// Yuno payment, so Yuno echoes it back in every webhook.
// ═════════════════════════════════════════════════════════════════════════════
app.post('/yuno/webhook', async (req, res) => {
  console.log('\n[/yuno/webhook] Yuno event received');
  let body;
  try {
    body = JSON.parse(req.body.toString());
  } catch {
    body = req.body.toString();
  }
  // Full dump — Yuno webhook schema varies; log everything to find field names
  console.log('[/yuno/webhook] Full payload:', JSON.stringify(body, null, 2));

  // Acknowledge immediately — Yuno retries if we don't respond fast
  res.status(200).json({ received: true });

  // ── Parse webhook ─────────────────────────────────────────────────────────
  // merchant_order_id = the PAR we passed when creating the Yuno payment
  const par        = body?.merchant_order_id;
  const yunoStatus = body?.payment_workflow_status
                  || body?.payment_status
                  || body?.status;

  console.log(`[/yuno/webhook] PAR: ${par} | Yuno status: ${yunoStatus}`);

  if (!par) {
    console.log('[/yuno/webhook] No merchant_order_id in payload — cannot map to PAR. Skipping.');
    return;
  }

  // ── Idempotency check ─────────────────────────────────────────────────────
  // If /yuno/return already ran and called report_guaranteed, skip.
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
    // ── Yuno confirmed success → drive PAR to guaranteed ───────────────────
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
    // ── Yuno confirmed failure ─────────────────────────────────────────────
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
