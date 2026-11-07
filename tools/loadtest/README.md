# JIT load test (T-0055)

A k6 test for `POST /v1/jit/card-authorizations` that gates the p99 under 300 ms (REQ-CRD-003, RUN-02). It runs against
**staging only**, with `PROVIDER_CARD=sim` (T-0040) so the card simulator's signature is what the service verifies and the
JIT decision path (card, controls, limits, balance, the T-0544 wallet lock, the hold journal) is the real one. Processor-side
latency is out of scope (ADR-006).

## What it sends

| Scenario | Shape |
|---|---|
| `steady` | `LOAD_RPS` (default 50, twice the pilot peak) signed authorisations for `LOAD_DURATION` (default 5m), spread over the cards in `cards.json`. About 10 % are declines, half unknown cards (`UNKNOWN_CARD`) and half amounts no wallet holds (`INSUFFICIENT_FUNDS`). |
| `burst` | Every `BURST_EVERY_S` (1) seconds, `BURST_SIZE` (5) authorisations for the one `burstCard` sent in parallel, so they race for the same funding wallet's lock. Some approve and some decline (balance, or the velocity rule of 10 per card per minute); both are normal answers. |

A decline is an HTTP 200, so it is not a failure. A non-200 answer, a transport error or an answer that is neither
`APPROVED` nor `DECLINED` is. Thresholds (k6 exits non-zero when either is crossed): `http_req_duration` `p(99)<300` and
`http_req_failed` `rate<0.01`.

## Variables

| Name | Needed | Meaning |
|---|---|---|
| `JIT_URL` | yes | The full staging URL, `https://<staging jit host>/v1/jit/card-authorizations`. |
| `JIT_SIGNATURE` | yes | The value of the `x-sim-signature` header. The simulator accepts the constant `sim`; the real value is never in the repo. In the workflow it is the secret `STAGING_JIT_SIGNATURE`. |
| `CARDS_FILE` | no | Path of the card manifest, default `./cards.json` beside the script. |
| `LOAD_RPS`, `LOAD_DURATION` | no | 50 and `5m`. |
| `BURST_SIZE`, `BURST_EVERY_S` | no | 5 and 1. |
| `DECLINE_SHARE` | no | 0.1. |

Signing: the card simulator's `parseAuthorization` checks `x-sim-signature === 'sim'` and parses the JSON body; there is no HMAC
today. `lib.mjs` `signHeaders()` builds that header from `JIT_SIGNATURE` and `buildRequest()` makes the body in the shape
`CardIssuingSimulator.authorize()` makes (the node test checks both against the real simulator). When a processor adapter with an
HMAC scheme is tested this way, `signHeaders` is the one place to add `k6/crypto` `hmac`.

## Safety

The target is refused, before any request, when it could be production:

- `lib.mjs` `assertNotProd(JIT_URL)` runs in `jit.js`'s init context, in `seed.mjs check` and, as `node tools/loadtest/guard.mjs "$JIT_URL"`, as the workflow's first step (before k6 is installed).
- It refuses a host with a `prod`, `production`, `prd` or `live` label, a host that does not also name `staging`, `stage`, `stg`, `preview`, `sandbox`, `dev` or `localhost`, credentials in the URL, plain http outside localhost, and any path other than the JIT route.
- The workflow has `workflow_dispatch` and a nightly `schedule` only, `permissions: contents: read`, and reads the target from the repository variable `STAGING_JIT_URL`. It is skipped while that variable is empty. Nothing is echoed; the signature is a secret and so masked.

If staging's host does not contain one of those words, name it so or the guard will refuse it: the guard errs toward refusing.

## Seeding staging

The public API cannot make funded test cards on its own: sign-in needs a passkey ceremony, a load needs a step-up younger than
5 minutes, and no endpoint returns the processor card id the JIT call is keyed by (`CardView` has only our id). So seeding is
three steps; `seed.mjs` does the two that can be scripted:

1. **Members and cards.** For each test member (a `+1555...` test number on the `sim` auth port), sign in through the app or the simulator panel, start a T2 KYC session (`POST /v1/kyc/sessions`) and post the simulator's approval to `POST /v1/hooks/kyc` (header `x-sim-signature: sim`, body `{ eventId, sessionId, status: "approved" }`); approval issues the virtual card (the same path as `jit.bench.test.ts`). Make at least 20 members for the steady scenario (the velocity rule allows 10 approvals per card per minute) plus one for the burst wallet.
2. **Funds.** Load each purse with `POST /v1/loads` (payment method fixture `pm_ok`, a fresh step-up), enough for the run: about `LOAD_RPS x duration x 0.9 x 1,000 minor / cards`. The burst wallet should hold a little: it is meant to run dry and exercise the lock.
3. **Manifest.** A person with read access to the staging database runs the seed query and saves its rows as JSON, then `node tools/loadtest/seed.mjs manifest --input rows.json` writes `cards.json` (active cards funded to at least `--min-balance`, the richest becomes `burstCard`). Store the file's contents in the repository variable `STAGING_LOADTEST_CARDS` for the workflow. Card ids are not secrets.

Seed query (read-only; run it from inside the VPC like the other staging queries):

```sql
select c.processor_card_id, c.status, (-coalesce(b.balance_minor, 0))::text as balance_minor
  from cards.card c
  join ledger.account w on w.owner_party_id = c.party_id and w.type = 'wallet' and w.currency = 'ILS'
  left join ops.account_balance b on b.account_id = w.id
 where c.status = 'active';
```

(Balances are credit-normal, so the member's money is the negative of the ledger balance.) Check the target answers with
`node tools/loadtest/seed.mjs check --url "$JIT_URL" --signature "$JIT_SIGNATURE"`: one unknown-card probe that moves no money.

## Running it

```
JIT_URL=https://<staging jit host>/v1/jit/card-authorizations JIT_SIGNATURE=sim \
  k6 run --summary-export loadtest-summary.json tools/loadtest/jit.js
```

or from GitHub: Actions, loadtest, Run workflow (the nightly run uses the defaults). Each run leaves holds on the test
wallets (`auth_hold` journals); they are test money on staging, and a fresh load tops the wallets up.

## Reading the result

- **Client side (k6):** the end-of-run summary and `loadtest-summary.json` give `http_req_duration` p(95)/p(99) and `http_req_failed`; the run passes only if both thresholds hold. The workflow prints them in the job summary and attaches the JSON. `jit_approved`, `jit_declined` and `jit_unexpected` count the answers (declines should be about a tenth of the steady scenario, plus the burst's); `jit_unexpected` should be 0.
- **Server side (cross-check):** the service emits one EMF line per decision (T-0053), namespace `Kesher`: `jit.decision_ms` (milliseconds, no dimensions) and `jit.error` (0 or 1; its Average is the error rate, 1 = failed closed with a TIMEOUT decline). In CloudWatch Metrics, graph `Kesher / jit.decision_ms` with statistic p99, period 1 minute, over the run's window, and `jit.error` Average. `jit.decision_ms` is the decision only, so it is lower than k6's number by the network and the HTTP stack; a p99 well above k6's, or `jit.error` over 0.01 while k6 saw no failures, means the service is declining TIMEOUT at its 250 ms budget (those are 200s, so k6 does not count them as failures). Logs Insights over the JIT log group: `filter ispresent(jit.decision_ms) | stats pct(jit.decision_ms, 99), avg(jit.error) by bin(1m)`.
- A failed run: follow RUN-02 (database CPU, replica lag, the `jit` service's desired count) and rerun at the same rate.
