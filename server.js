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
  // (CPMT ID is in the return_url query param redirect_pm_type — extract if needed)
  const yunoPaymentMethod = 'DUIT_NOW'; // default; extend CPMT_TO_YUNO_PM map for TNG etc.

  console.log('[/yuno/payments] Resolved:', { amount, currency, yunoPaymentMethod, merchantOrderId });

  // ── 4. Call Yuno API to create payment session ────────────────────────────
  let yunoPaymentIntent;
  try {
    const yunoReturnUrl =
      `${config.adapter.baseUrl}/yuno/return` +
      `?stripe_return=${encodeURIComponent(stripeReturnUrl)}` +
      `&par=${encodeURIComponent(paymentAttemptRecord)}`;

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
        type: yunoPaymentMethod,                     // 'DUIT_NOW' | 'TOUCH_N_GO'
      },
      checkout: {                                    // required — return_url lives here
        return_url:  yunoReturnUrl,
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
  // Yuno response shape: yunoPaymentIntent.checkout.redirect_to
  // (verify in Yuno sandbox — may also be yunoPaymentIntent.redirect_url)
  const redirectUrl = yunoPaymentIntent?.checkout?.redirect_to
                   || yunoPaymentIntent?.redirect_url;

  if (!redirectUrl) {
    console.error('[/yuno/payments] No redirect URL in Yuno response');
    return res.status(502).json({ error: 'no_redirect_url' });
  }

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
      },
    },
    payment_reference: yunoPaymentIntent.id, // Yuno's payment intent ID as our stable reference
  });
});


// ═════════════════════════════════════════════════════════════════════════════
// GET /yuno/return
// Yuno redirects the customer here after payment (success or failure).
// We verify the outcome, then send the customer to Stripe's success_url.
// ═════════════════════════════════════════════════════════════════════════════
app.get('/yuno/return', async (req, res) => {
  console.log('\n[/yuno/return] Customer returned from Yuno');
  console.log('[/yuno/return] Query:', req.query);

  const { stripe_return, par } = req.query;

  // Yuno may pass payment status query params — log them all
  // e.g. ?status=SUCCEEDED&payment_id=xxx or similar
  const yunoStatus = req.query.status || req.query.payment_status;
  const yunoPaymentId = req.query.payment_id || req.query.id;

  console.log(`[/yuno/return] Yuno status: ${yunoStatus}, payment_id: ${yunoPaymentId}`);

  // Optional: call Stripe Payment Records API to record the off-Stripe payment
  // (good for production, can skip for POC demo)
  // await reportToStripePaymentRecords(yunoPaymentId, checkout_session_id);

  // Redirect customer to Stripe's original success_url
  if (stripe_return) {
    return res.redirect(decodeURIComponent(stripe_return));
  }

  // Fallback if no return URL
  res.send('<h1>Payment complete</h1><p>You can close this window.</p>');
});


// ═════════════════════════════════════════════════════════════════════════════
// POST /yuno/webhook
// Yuno sends async payment notifications here.
// Useful for confirming final payment status independently of the redirect.
// ═════════════════════════════════════════════════════════════════════════════
app.post('/yuno/webhook', (req, res) => {
  console.log('\n[/yuno/webhook] Yuno event received');
  let body;
  try {
    body = JSON.parse(req.body.toString());
  } catch {
    body = req.body.toString();
  }
  console.log('[/yuno/webhook] Payload:', JSON.stringify(body, null, 2));

  // TODO: validate Yuno webhook signature, update payment state
  // For demo, just acknowledge
  res.status(200).json({ received: true });
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
