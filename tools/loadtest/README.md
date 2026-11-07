# JIT load test (T-0055)

A k6 test for `POST /v1/jit/card-authorizations` that gates the p99 under 300 ms (REQ-CRD-003, RUN-02). It runs against
**staging only**, with `PROVIDER_CARD=sim` (T-0040) so the card simulator's signature is what the service verifies and the
JIT decision path (card, controls, limits, balance, the T-0544 wallet lock, the hold journal) is the real one. Processor-side
latency is out of scope (ADR-006).

## What it sends

| Scenario | Shape |
|---|---|
| `steady` | `LOAD_RPS` (default 50, twice the pilot peak) signed authorisations for `LOAD_DURATION` (default 5m), spread over the cards in `cards.json`. About 10 % are declines, half unknown cards (`UNKNOWN_CARD`) and half amounts no wallet holds (`INSUFFICIENT_FUNDS`). |
| `burst` | Every `BURST_EVERY_S` (1) seconds, `BURST_SIZE` (5) authorisations for ONE wallet sent in parallel, so they race for that funding wallet's lock (`postNoOverdraft`, T-0544). Each burst uses the next of the `burstCards` in rotation: the velocity rule (10 approvals per card in a sliding minute) would otherwise decline a single card's burst after two seconds, before the lock path. With 30 burst cards each card is hit once every 30 s, 5 approvals per minute. The wallets are funded enough for every approval, so what this measures is latency under lock contention on one wallet; the in-lock INSUFFICIENT_FUNDS decline (a wallet drained between the early read and the hold) is proved by the T-0544 unit test, not here. |

A decline is an HTTP 200, so `http_req_failed` does not count it; that metric sees only non-2xx/3xx answers and transport errors. The service also FAILS CLOSED: a throw or a budget overrun (250 ms) is a 200 `DECLINED` with reason `TIMEOUT`, which `http_req_failed` cannot see either, so the script reads the body. Thresholds (k6 exits non-zero when any is crossed): `http_req_duration` `p(99)<300`, `http_req_failed` `rate<0.01`, `jit_timeout_rate` `rate<0.01` (the share of answers that are `TIMEOUT`, the same event as `jit.error`), `jit_unexpected_rate` `rate<0.01` and `jit_unexpected` `count<1` (a non-200 or an answer that is neither `APPROVED` nor `DECLINED`).

## Variables

| Name | Needed | Meaning |
|---|---|---|
| `JIT_URL` | yes | The full staging URL, `https://<staging jit host>/v1/jit/card-authorizations`. |
| `JIT_SIGNATURE` | yes | The value of the `x-sim-signature` header. The simulator accepts the constant `sim`; the real value is never in the repo. In the workflow it is the secret `STAGING_JIT_SIGNATURE`. |
| `CARDS_FILE` | no | Path of the card manifest, default `./cards.json` beside the script. |
| `LOAD_RPS`, `LOAD_DURATION` | no | 50 and `5m`. |
| `BURST_SIZE`, `BURST_EVERY_S` | no | 5 and 1. |
| `DECLINE_SHARE` | no | 0.1. |
| `ALLOW_FEW_CARDS` | no | Set to `1` for a smoke run with fewer cards than the velocity rule needs (the script otherwise refuses to start, see Seeding). |

Signing: the card simulator's `parseAuthorization` checks `x-sim-signature === 'sim'` and parses the JSON body; there is no HMAC
today. `lib.mjs` `signHeaders()` builds that header from `JIT_SIGNATURE` and `buildRequest()` makes the body in the shape
`CardIssuingSimulator.authorize()` makes (the node test checks both against the real simulator). When a processor adapter with an
HMAC scheme is tested this way, `signHeaders` is the one place to add `k6/crypto` `hmac`.

## Safety

The target is refused, before any request, when it could be production:

- `lib.mjs` `assertNotProd(JIT_URL)` runs in `jit.js`'s init context, in `seed.mjs check` and, as `node tools/loadtest/guard.mjs "$JIT_URL"`, as the workflow's first step (before k6 is installed).
- It accepts only a host equal to `staging.kesher.example` or ending in `.staging.kesher.example` (the zone in `infra/terraform/envs/staging`), or `localhost` / `127.0.0.1`, and still refuses a `prod`, `production`, `prd` or `live` label inside it. It refuses a host with anything but lower-case letters, digits, dots and hyphens, any backslash, whitespace, control character or `@` (a URL parser reads a backslash as a slash and strips tabs and newlines, so the text could name one host and the client connect to another), a host the `URL` global reads differently, plain http outside localhost, and any path other than the JIT route.
- The workflow has `workflow_dispatch` and a nightly `schedule` only, `permissions: contents: read`, and reads the target from the repository variable `STAGING_JIT_URL`. It is skipped while that variable is empty. Nothing is echoed; the signature is a secret and so masked.

If staging's zone changes, change `STAGING_ZONE` in `lib.mjs` and the tests with it: the guard errs toward refusing.

## Seeding staging

The public API cannot make funded test cards on its own: sign-in needs a passkey ceremony, a load needs a step-up younger than
5 minutes, and no endpoint returns the processor card id the JIT call is keyed by (`CardView` has only our id). So seeding is
three steps; `seed.mjs` does the two that can be scripted:

1. **Members and cards.** For each test member (a `+1555...` test number on the `sim` auth port), sign in through the app or the simulator panel, start a T2 KYC session (`POST /v1/kyc/sessions`) and post the simulator's approval to `POST /v1/hooks/kyc` (header `x-sim-signature: sim`, body `{ eventId, sessionId, status: "approved" }`); approval issues the virtual card (the same path as `jit.bench.test.ts`). The velocity rule (10 approvals per card in a sliding minute) sets how many: the steady scenario needs `ceil(LOAD_RPS x 0.9 x 60 / 10)` cards (270 at 50 req/s) and the burst scenario `ceil(BURST_SIZE x 60 / (BURST_EVERY_S x 10))` burst cards (30 at the defaults). `jit.js` refuses to start with fewer (`ALLOW_FEW_CARDS=1` overrides for a smoke run, with a warning).
2. **Funds.** Load each purse with `POST /v1/loads` (payment method fixture `pm_ok`, a fresh step-up), enough for the run: about `LOAD_RPS x duration x 0.9 x 1,000 minor / cards`. Fund the burst wallets too: they must cover every approval of the run, or the burst turns into balance declines instead of lock contention.
3. **Manifest.** A person with read access to the staging database runs the seed query and saves its rows as JSON, then `node tools/loadtest/seed.mjs manifest --input rows.json` writes `cards.json` (active cards funded to at least `--min-balance`; the richest `--burst-cards`, default 30, become `burstCards`, the rest `cards`). Store the file's contents in the repository variable `STAGING_LOADTEST_CARDS` for the workflow. Card ids are not secrets.

Seed query (read-only; run it from inside the VPC like the other staging queries):

```sql
select c.processor_card_id, c.status, (-coalesce(b.balance_minor, 0))::text as balance_minor
  from cards.card c
  join ledger.account w on w.owner_party_id = c.party_id and w.type = 'wallet' and w.currency = 'ILS'
  left join ops.account_balance b on b.account_id = w.id
 where c.status = 'active';
```

(Balances are credit-normal, so the member's money is the negative of the ledger balance.) Check the target answers with
`JIT_SIGNATURE=... node tools/loadtest/seed.mjs check --url "$JIT_URL"`: one unknown-card probe that moves no money.

## Running it

```
JIT_URL=https://<staging jit host>/v1/jit/card-authorizations JIT_SIGNATURE=sim \
  k6 run --summary-export loadtest-summary.json tools/loadtest/jit.js
```

or from GitHub: Actions, loadtest, Run workflow (the nightly run uses the defaults). Each run leaves holds on the test
wallets (`auth_hold` journals); they are test money on staging, and a fresh load tops the wallets up.

## Reading the result

- **Client side (k6):** the end-of-run summary and `loadtest-summary.json` give `http_req_duration` p(95)/p(99) and `http_req_failed`; the run passes only if both thresholds hold. The workflow prints them in the job summary and attaches the JSON. `jit_approved`, `jit_declined` and `jit_unexpected` count the answers (declines should be about a tenth of the steady scenario); `jit_unexpected` must be 0 and `jit_timeout_rate` under 1 %.
- **Server side (cross-check):** the service emits one EMF line per decision (T-0053), namespace `Kesher`: `jit.decision_ms` (milliseconds, no dimensions) and `jit.error` (0 or 1; its Average is the error rate, 1 = failed closed with a TIMEOUT decline). In CloudWatch Metrics, graph `Kesher / jit.decision_ms` with statistic p99, period 1 minute, over the run's window, and `jit.error` Average. `jit.decision_ms` is the decision only, so it is lower than k6's number by the network and the HTTP stack; a p99 well above k6's, or `jit.error` over 0.01 while k6 saw no failures, means the service is declining TIMEOUT at its 250 ms budget (those are 200s, which `http_req_failed` misses; `jit_timeout_rate` is the k6-side gate for them). Logs Insights over the JIT log group: `filter ispresent(jit.decision_ms) | stats pct(jit.decision_ms, 99), avg(jit.error) by bin(1m)`.
- A failed run: follow RUN-02 (database CPU, replica lag, the `jit` service's desired count) and rerun at the same rate.
