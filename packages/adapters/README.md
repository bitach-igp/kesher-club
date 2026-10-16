# packages/adapters

`@kesher/adapters` — vendor adapters behind the ports of `@kesher/ports` (constitution art. 1). One folder
per vendor under `src/`; each adapter `implements` its port, passes the port's contract suite on every
PR against an in-memory fake of the vendor API, and nightly against the vendor sandbox. App and domain
code never import from here directly; the provider registry binds a capability to a vendor per market.

Rules that apply to every adapter here:

- No vendor SDKs. Each adapter talks to the vendor's REST API through an injected `fetch`
  (constructor option, default `globalThis.fetch`), which is how the fakes plug in.
- Secrets arrive as constructor options (`secretKey`, `clientSecret`, `apiSecret`, …). Adapters never
  read `process.env`; the app's Zod config loader does, and missing config crashes on boot.
- Money is `Money { minor: bigint; currency }`. Vendor decimals are parsed to minor units as strings;
  there is no float arithmetic on amounts.
- Adapters never retry. Retries, timeouts and compensation belong to the Temporal workflow calling the port.
- Unknown vendor responses fail secure (`PROVIDER_UNAVAILABLE` or a typed port error), never a silent success.
- Never log PAN, CVV, OTPs, tokens, client secrets or PII. Vendor ids only go to `ops.external_ref`.
- Webhooks are signature-verified and deduped by vendor event id inside `parseWebhook`; the HTTP
  handler stores the raw event in `ops.inbound_event` and a worker calls the adapter.

Commands: `pnpm --filter @kesher/adapters typecheck`, `pnpm --filter @kesher/adapters test`, root `pnpm lint`.

## stripe — `StripeBillingAdapter` (BillingPort) and `StripeFundingAdapter` (FundingPort) · T-0301

Flag: `billing.stripe` (wallet buttons additionally follow `billing.applePay` / `billing.googlePay`).

| Port | Stripe objects | Notes |
|---|---|---|
| `BillingPort` | Customers, SetupIntents, Subscriptions, invoice webhooks | `createSetupSheet` returns the SetupIntent client secret and echoes the wallet flags for the Payment Element's `wallets` option. Subscriptions carry a fixed term through `cancel_at` (10 months for the academic year) and the locked plan price inline (`price_data`); `planProducts` maps our plan codes to Stripe product ids. Pause/resume use `pause_collection`; `cancel('now')` is `DELETE`, `cancel('period_end')` is `cancel_at_period_end=true`. |
| `FundingPort` | PaymentIntents (`card` for card/Apple Pay/Google Pay, `us_bank_account` for ACH) | ACH loads come back `on_hold` with `holdUntil` = 3 business days (`addBusinessDays` from `@kesher/ports`). RTP is refused with `UNSUPPORTED_METHOD`. A webhook whose amount differs from the load this instance created is refused. |

Idempotency: every mutating call sends Stripe's `Idempotency-Key` header *and* goes through a local
`IdempotencyStore`, so the same key returns the same result without a second vendor call.

Webhooks: `Stripe-Signature` (`t=…,v1=HMAC-SHA256(secret, "<t>.<body>")`) verified in constant time
with a 5-minute tolerance; events are deduped by `event.id`. Event types this adapter does not
understand are refused (`INVALID_STATE` / `VALIDATION_FAILED`), so subscribe the endpoint only to
`invoice.paid`, `invoice.payment_failed`, `customer.subscription.*` and `payment_intent.*`.

Sandbox credentials (names only; values live in the environment's secret store):
`STRIPE_SANDBOX_SECRET_KEY`, `STRIPE_SANDBOX_BILLING_WEBHOOK_SECRET`, `STRIPE_SANDBOX_FUNDING_WEBHOOK_SECRET`,
and the Stripe product ids for `planProducts` (`STRIPE_PRODUCT_CLUB`, …).

Tests: `billingContract('stripe', …)` and `fundingContract('stripe', …)` run against `src/stripe/fake-stripe.ts`
(form-encoded requests, `Idempotency-Key` replay, signed webhooks, fixtures for declines, outages, 3DS and ACH),
plus unit tests for the signature scheme (tolerance window, forged and malformed headers).

## airalo — `AiraloEsimAdapter` (EsimPort) · T-0710 · REQ-ESIM-001

Flag: `esim.airalo`.

Airalo Partner API v2: client-credentials token from `POST /v2/token` (cached until shortly before
expiry), `GET /v2/packages?filter[type]=local&filter[country]=IL`, `POST /v2/orders`
(`package_id`, `quantity=1`, `type=sim`, `description=<idempotency key>`), `GET /v2/sims/{iccid}/usage`,
`POST /v2/orders/topups`. Package prices (USD decimals) become `Money` USD minor units; `amount` (MB)
becomes `dataGb`; unlimited packages are skipped. `lpa` is the order's `qrcode` (`LPA:1$…`), or is
built from `lpa` + `matching_id`; `installUrl` is the iOS 17.4 universal link
`https://esimsetup.apple.com/esim_qrcode_provisioning?carddata=<LPA>`. Airalo has no idempotency
header, so orders and top-ups are guarded by a local `IdempotencyStore` keyed by the workflow's key.

Sandbox credentials (names only): `AIRALO_SANDBOX_CLIENT_ID`, `AIRALO_SANDBOX_CLIENT_SECRET`
(base URL `https://sandbox-partners-api.airalo.com`).

Tests: `esimContract('airalo', …)` against `src/airalo/fake-airalo.ts` with the `israel-fail-1gb`
fixture returning 503 (→ `PROVIDER_UNAVAILABLE`), plus mapping, token-caching and decimal-parsing tests.

## cover-genius — `CoverGeniusInsuranceAdapter` (InsurancePort) · T-0720 · REQ-INSR-001

Flag: `insurance.coverGenius`.

XCover Partner API: `POST /x/partners/{partner}/quotes/` (one policy type per quote),
`POST /bookings/{quoteId}/` to bind, `POST /bookings/{id}/cancel/`, `GET /bookings/{id}/`. Requests are
signed with XCover's HTTP Signature scheme (`Authorization: Signature keyId=…,algorithm="hmac-sha1",…`
over the `Date` header). XCover's quote package id is our `quoteId` and, once confirmed, the `policyId`.

Disclosures travel with every quote: `licensedEntity` and `commissionDisclosure` are fixed,
compliance-approved wording given to the constructor (it refuses to start without them, and the
commission wording must mention "commission"); `policyWordingUrl` is the quote's `pds_url` from the
vendor — a quote without an https `pds_url` is refused rather than shown. `commission` is the quote's
`partner_commission` when XCover states it, otherwise `commissionBps` from the product mapping; a
commission outside the premium is refused. `products` maps our product codes to XCover policy types;
unknown codes never reach the vendor (`UNKNOWN_PRODUCT`).

Sandbox credentials (names only): `XCOVER_SANDBOX_PARTNER_CODE`, `XCOVER_SANDBOX_API_KEY`,
`XCOVER_SANDBOX_API_SECRET` (base URL `https://api.sandbox.xcover.com`).

Tests: `insuranceContract('cover-genius', …)` against `src/cover-genius/fake-xcover.ts` (signature
verification, quote expiry, cancel-once), with the `always_down` policy type as the outage fixture.
