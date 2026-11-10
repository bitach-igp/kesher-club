# Crowded (US banking, ILS transfers coming) — vendor notes

**Role in Kesher:** optional, Phase 2. US banking (at i3 Bank) for collecting fees from US parents and funding
master accounts by ACH, behind `InstitutionBankingPort`, flag `institutions.usBanking` (default off).
Requirements REQ-INS-022 to REQ-INS-026; cards T-0647 to T-0656. Kesher never holds a student's personal
balance there.

**What Ezra learned (2026-11-02 office demo, not yet in writing).** Superseded where the 2026-11-04 meeting documents say otherwise
(see "Meeting documents, 2026-11-04" below): they are written up from the Nov 1 recording "Ezra x Crowded" (1h 22m, Tel Aviv), speaker
labels unreliable, partner names as transcribed. Nothing in them is from Crowded in writing.

- Crowded is not limited to nonprofits. A regular company can sign up as long as its business is related to
  Israel, so **Israel Global Pay, LLC** can be the account holder.
- Crowded runs a general nonprofit under its own umbrella that institutions without a 501(c)(3) can work under.
- **ILS transfers are due in 4–6 weeks** (the meeting recording says about four weeks from Nov 1, to be confirmed with Dave, a Crowded contact named in the recording). If they pay Israeli accounts, Crowded could be a USD→ILS route as well
  as a US bank (card T-0656 evaluates it against our FX and payout ports).

So the account holder is one of three setups, still to be decided (question 2 below):

| Setup | Account holder | Institution's money |
|---|---|---|
| A. Platform account | Israel Global Pay, LLC | A sub-account per institution if Crowded offers them, otherwise our ledger tracks each institution's share |
| B. Own entity | The institution's US entity (an American Friends 501(c)(3), or any company) | Its own account, linked by us as partner |
| C. Crowded umbrella | Crowded's general nonprofit, for the institution | Ownership and donor receipts to be confirmed |

The port models a **holder** (`platform` or `institution`) so the cards work under any of the three.

- Full endpoint inventory: [api-inventory.md](api-inventory.md) (79 operations, read 2026-11-03).
- Sandbox: `https://sandbox-api.crowdedfinance.com/api/v1`. Production host: not documented.

## How Crowded maps onto Kesher

| Crowded | Kesher | Notes |
|---|---|---|
| Organization | Israel Global Pay, LLC (setup A), or the institution's US entity (B) | Created by us as partner, or self-onboarded through an onboarding link |
| Chapter | One per institution under our organization (A), or the entity's banking unit (B) | Holds the account, contacts, collections, counterparties, the bank application; whether each chapter gets its own account number is question 2 |
| Application (hosted form) | The bank's own KYB of the account holder | Separate from and additional to our KYB (REQ-INS-010/011) |
| Contact | A US funder (parent) paying a fee | Created by mobile; placeholder mobiles can't receive SMS |
| Collection + Intent | A fee billed to funders (I08) | Intent's `paymentUrl` is the hosted payment page; card or ACH |
| Counterparty + ACH origination | Funding the Kesher master account | ACH credit to Kesher's US collection account, KC- reference in `addenda` (in setup A with one shared account, a book transfer or ledger move instead) |
| ILS transfer (not yet released) | A payout or FX route to Israeli accounts | Evaluated in T-0656; no build until it is live and documented |
| Transactions, collect payments | The linked account's statement and reconciliation | Read-only |
| Webhooks (batched, HMAC-SHA256) | `ops.inbound_event`, provider `crowded` | Dedupe on `eventId`; ACH/wire events are hints, re-read the payment |
| Cards (wallet / perdiem) | Not used yet; reopened by the 2026-11-04 meeting | Per the recording, per diem and expense cards work in USD in Israel today (ATMs too), digital with Apple/Google Wallet, light KYC (to confirm); but the API has no spend-control or PIN endpoint and physical cards ship to the US only. See "Meeting documents" |

## Integration rules (from the docs; enforce in the adapter)
- Amounts are integer cents, USD only → `Money { minor: bigint, currency: 'USD' }`. Reject any other currency.
- Idempotency is a body field `idempotencyKey` (UUID), not a header, and several creates have none
  (organization, chapter, contacts, collection). Before retrying those, look the object up (by name or
  external ref) instead of creating again.
- Business rejections can arrive as HTTP 201 with `status: "Rejected"`; bulk calls return 200 with
  per-item errors. Treat both as failures in the port.
- Enum casing differs by surface (`Cancelled` vs `canceled`, `Card` vs `card`): normalise in one mapper.
- IDs are mixed (UUIDs, numeric strings, numbers): store them all as strings in `ops.external_ref`.
- Webhook signature: verify HMAC-SHA256 over the **raw body** (the docs also show re-stringified JSON;
  confirm with Crowded). No timestamp in the signature, so dedupe by `eventId` is the replay defence.
- Never log `accountNumber` (returned unmasked), SSNs or officer details.

## Open questions

### First message to Crowded (sent by Zvi in the group, 2026-11-03)
1. **ILS transfers:** can they pay personal Israeli bank accounts as well as businesses, and how is the rate set?
2. **Account structure:** can one Israel Global Pay account hold a sub-account (own account number) per
   institution, or does each institution onboard on its own?

### For Ezra (business)
3. **Who is the customer:** Israel Global Pay as holder with institutions under it, or each institution signing up itself? Decides who carries compliance and the money-transmission question.
4. **"Related to Israel":** does a US yeshiva's gap-year program count? A family paying living costs?
5. **Economics:** fees per account, collection, ACH and ILS transfer; any partner revenue share.
6. **ILS timing:** is 4–6 weeks in writing, pilot or general availability, and can we get early access before the season?
7. **Umbrella nonprofit:** who legally owns the money, who issues donor receipts, is it tax-deductible?
8. **Students:** can students or parents be cardholders or end users, or is it business-only?

### For Crowded's developers, once we have a sandbox key
9. **Credentials:** how a partner is issued `api_token` / `partner_jwt`, their lifetime, refresh and scopes; the production base URL.
10. **Webhook signature:** raw body or re-stringified JSON? Is a timestamp or replay window planned?
11. **ACH event names:** are `finance.ach_payment.*` / `finance.wire_payment.*` subscribable today (they're missing from the event-types list)?
12. **ILS API:** a new payment type on `POST /chapters/{id}/payments` or a new API; quote lock and its length; settlement time and the event that says it arrived.
13. **Amounts:** collect payment `amount` is gross in REST and net in webhooks: which is right? Unit of `standardAmount` and of subaccount `fund.amount`?
14. **Idempotency:** behaviour on a reused key with a different body; retention beyond ~48 h; dedupe on organization/chapter/contact/collection creates.
15. **Sandbox:** simulation of card and ACH collections and of ILS transfers (none documented); refund completion event (`collect.refund.completed` isn't listed).
16. **Rate limits:** headers and the 429 body for the 1,000/min limit; retry guidance for 5xx.
17. **Data:** why `accountNumber` is returned unmasked; data-processing terms; retention.

## Answers log
Record each answer here with its date; an unanswered question keeps its owner and the date it was sent. Which card
waits on which question is in `specs/tasks/T-0655.md`.

| # | Owner | Sent | Answered / source | Answer |
|---|---|---|---|---|
| 1 ILS transfers | Zvi | 2026-11-03 | 2026-11-04 (meeting recording, to confirm) | Per recording: Shekel wallets with instant in-wallet conversion (via stablecoins), then a local payout ("Masaf") in Israeli business hours, about one business day, Friday and Saturday wait; Citi Israel for institutional payouts. Personal vs business recipients not stated. Cap of ILS 2,000 a day per account for local Israeli money movement, scope unclear |
| 2 Account structure | Zvi | 2026-11-03 | 2026-11-04 (meeting recording, to confirm) | Per recording: Both exist. A *sub-account* (a project, trip or program) sits under the holder's entity and its own KYB. A *related entity* is a separate business with its own account, KYB on the entity and KYC on its officer, invited by link, email or CSV. A per diem account has its own wallet, ledger and bank details. Subscription tier limits the number of sub-accounts (Postman, 429) |
| 3 Who is the customer | Ezra | — | 2026-11-04 (meeting recording, to confirm) | Per recording: Israel Global Pay as holder with customers under it works if each customer funds from its own account and the platform does not act as a money transmitter on their behalf; Crowded discourages one officer paying out hundreds of per diem accounts for unrelated purposes and recommends a foundation or fiscal sponsor |
| 4 "Related to Israel" | Ezra | — | — | — |
| 5 Economics | Ezra | — | 2026-11-04 (meeting recording, to confirm) | Per recording: Float paid nightly on balances at about 60% of the midpoint of the Fed rate (about 2.5% annualized); interchange up to about 100 bps of card spend depending on volume, with some pass-through costs. Whether the share is negotiable and what the pass-through costs are: not answered |
| 6 ILS timing | Ezra | — | 2026-11-04 (meeting recording, to confirm) | Per recording: About four weeks from Nov 1, to be confirmed with Dave (a Crowded contact named in the recording); not in writing. Shekel and international wallets are built but not live |
| 7 Umbrella nonprofit | Ezra | — | 2026-11-04 (meeting recording, to confirm) | Per recording: Crowded runs two 501(c)(3)s, one general and one military-focused; an LLC can own a nonprofit. Who legally owns the money and who issues donor receipts: not answered |
| 8 Students | Ezra | — | 2026-11-04 (meeting recording, to confirm) | Per recording: Per diem cardholders (students, kollel) need light KYC only: personal ID, date of birth, email, no ID photo. Cardholders outside the US and the ID type accepted for Israeli residents: not stated |
| 9 Credentials | Zvi | — | — | — |
| 10 Webhook signature | Zvi | — | 2026-11-10 (Crowded's reply, quoting their published webhook docs; partial) | Header `X-Webhook-Signature: sha256=<hex>`, HMAC-SHA256 with the webhook secret "of the raw request body (JSON string)"; the signature covers the whole batch. Their sample code recomputes over `JSON.stringify(payload)` of the parsed body, so raw bytes versus re-stringified is still not stated outright; we verify over the raw bytes. No timestamp is in the signature: dedupe on `eventId` (their own advice) is the replay defence. Still open: whether a replay window is planned. |
| 11 ACH event names | Zvi | — | 2026-11-10 (our sandbox key, `GET /webhooks/event-types`) | Yes, subscribable in the sandbox: `finance.ach_payment.{processing,sent,returned,canceled,failed}` and `finance.wire_payment.{sent,returned,canceled,failed}` (no wire `processing`); also `collect.refund.{initiated,processing,reversed}` and `collect.payment.refunded`, but no `collect.refund.completed` (question 15). 50 event types in all. |
| 12 ILS API | Zvi | — | — | — |
| 13 Amounts | Zvi | — | — | — |
| 14 Idempotency | Zvi | — | 2026-11-10 (the published docs, view `2sBYArTsS6`; Crowded to confirm) | ACH and wire payments: a second request with the same key while the first is in flight is `409 DUPLICATE_REQUEST` ("retry shortly"); after the first completes, a repeat with the same key returns the payment it produced. Counterparty create and delete: 409 `DUPLICATE_REQUEST` while another is in flight. Book payments: a reused key is the per-item error `DUPLICATE_PAYMENT` ("Idempotency key already used"), not an HTTP 409. Keys are scoped to the chapter. Still open: a reused key with a different body, retention beyond about 48 hours, and the sub-account fund call (its response is undocumented). Crowded has no key on organization, chapter, contact or collection creates. |
| 15 Sandbox | Zvi | — | — | — |
| 16 Rate limits | Zvi | — | — | — |
| 17 Data | Zvi | — | — | — |

## Meeting documents, 2026-11-04
Two documents written from the Nov 1 recording: *Crowded Meeting: Key Points for Ezra* and *Israel Global Pay: Architectural Integration
Document* (a design proposal, built without Crowded's technical docs). Where they say something the build assumed from the Nov 2 demo, they win;
where they contradict the Postman inventory on an API fact, the inventory wins until Crowded says otherwise.

**Stated in the recording (second-hand, not in writing; confirm each with Crowded):** a fresh US LLC can be the holder (Crowded pushes a new entity through onboarding; text them when applying); both sub-accounts
and related entities exist (the port's `platform` / `institution` holder covers both); two nonprofits exist for the umbrella setup.

**Changes what we assumed**
- *Cards.* Per the recording (to confirm), per diem and expense cards work now in USD, including ATMs in Israel, are digital with Apple/Google Wallet, and need light KYC. The
  API still has no spend-control, PIN or activation endpoint and ships physical cards to the US only (inventory section 7, items 20-23). So
  "not used" is now "possible for digital per diem cards, no spend rules we can set". Whether admins can see per diem transactions was
  inconsistent in the demo. Needs a decision card before any build.
- *First-party push only.* Crowded does not pull from third-party accounts (the API has no ACH debit either, inventory item 26); customers
  push in from their own bank to unique account details, consent at onboarding to conversion and again for every movement. REQ-INS-023
  collects fees from US parents on the hosted payment page. If the platform holds the account those are third-party funds in its wallet,
  where it briefly owns them and carries the exposure. Question 18 below. Until answered, prefer an institution-held account (setup B or C).
- *Limits (all per the recording, to confirm).* Incoming ACH credit about $300,000 a month (stated loosely), incoming Fedwire up to $20,000,000 a day, funding speed wire in hours
  and ACH 1-2 days, local Israeli money movement up to ILS 2,000 a day (scope unclear). Hosted-page ACH payments are incoming ACH.
- *Revenue.* Per the recording, float and interchange are credited to the holder's account nightly from an operations account. T-0654 does not compare credits,
  so it is unaffected. It does compare every outbound debit: if Crowded debits pass-through costs from the account they would be reported as
  `outbound_without_request` breaks each night (question 21). T-0618's deposit feed is Kesher's own bank (`BankPort`, waiting on ADR-006),
  not the Crowded institution accounts; if the Crowded-held account ever becomes that feed, a float credit with no KC- reference would open
  a suspense case every night.
- *Reconciliation.* The proposal compares balances as well as transfers nightly; T-0654 compares payments and outbound debits only.
- *Idempotency.* The proposal says every write carries a key; the API has none on organization, chapter, contact or collection creates
  (the adapter looks up first). Per the inventory the adapter is right and the proposal's rule does not hold for those calls.
- *API.* The proposal says no endpoint, webhook or sandbox detail was seen; the Postman inventory has them (79 operations, sandbox, batched
  HMAC webhooks). Still unknown: how a partner is issued a token, the production host, what the MCP server covers, how close the sandbox is.

**Not built, and the proposal expects it:** per-movement consent records, a bulk (CSV) onboarding of per diem contacts, a unique funding
account per member, purpose and recipient rules, an evidence pack per transfer, and a revenue ledger for float and interchange.

**Out of bounds per the recording (to confirm):** large private checks, property purchases and investments. Checks in Israel have no lockbox (US checks:
mobile deposit or lockbox).

### New questions (meeting)
18. **Hosted-page collections:** do payments by US parents on the hosted payment page into a platform-held sub-account count as first-party
    push, or does that make the platform a money transmitter for them?
19. **Limits:** does the roughly $300,000 a month incoming ACH limit apply per account or per holder, can it be raised, and what are the
    limits on outgoing ACH from a sub-account (the funding flow, REQ-INS-024)?
20. **Per diem visibility and cards:** can an admin see per diem transactions, which ID do non-US cardholders use, can digital-only cards be
    issued to cardholders outside the US?
21. **Pass-through costs:** are they debited from the account, as a transaction, and how are they named?
22. **Sub-account quota:** how many sub-accounts does our subscription tier allow (the API answers 429 over it)? *Observed 2026-11-10: our sandbox allows two sub-accounts (the third create answered 429 `SubscriptionQuotaExceededError`, "Limit has already been reached"); ask for the production tier's number and for the sandbox limit to be raised.*
23. **Shekel payout partner:** exact name and licence of the conversion and local payout partner (transcribed as "Tunes", Wise also named).

### New questions (docs comparison and the program proposal, 2026-11-10)
24. ~~**Production enablement**~~ *Answered by Crowded, 2026-11-10: counterparties, ACH and wire origination "will be turned on for production and ready to launch"; it is a staging thing in the testing environment that they configure when it is time for production. Sub-accounts: they will switch them on in the sandbox for us "now for testing". **Sub-accounts confirmed in the sandbox the same day** (see "Sub-accounts, 2026-11-10" below).*
25. ~~**Related Entities dashboard**~~ *Answered by our own sandbox test, 2026-11-10 (below): one partner token creates and reads several organizations and chapters; the dashboard is not needed for the API. Dropped.*
26. **Who is invoiced the platform fee** *(revenue timing answered; the fee payer is still open)*: Crowded (2026-11-10): revenue is paid **monthly or quarterly, "leaning more to for sure the monthly and not nightly"**; they will double-confirm. Still open: which entity is invoiced the $15,000 platform fee (the proposal nets it against Zuz LLC's share in one table and "Israel Global Pay" in another), and whether each entity gets its own statement.
27. ~~**Reused key, different body**~~ *Answered by our sandbox, 2026-11-10 (below) for ACH; the other calls are not worth a question. Dropped.*
28. ~~**Application idempotency**~~ *We do not depend on it (hosted form, read back by chapter). Dropped.*

## Crowded's replies, 2026-11-10
- **Applications (their reply):** they do not recall an idempotency key on the application create, it is unrelated to how an application is fetched, and applications have no external id and no metadata field. Nothing we do depends on either: we start the hosted form (`POST /chapters/{id}/applications/form`, which takes `contactIp`) and read the application with `GET /chapters/{id}/applications`, by chapter id, one application per chapter. Their published docs do list `idempotencyKey` as required on the direct submit (question 28).
- **Where they answer 409** (published docs; table in api-inventory.md section 5.5): the direct application submit while a hosted form is in progress (`ResourceConflictError`); ACH and wire payment creates, counterparty creates and counterparty deletes while another request with the same key (or the same counterparty) is in flight (`DUPLICATE_REQUEST`, "retry shortly"). A repeat of an ACH or wire after the first completed returns the original payment, not an error.
- **Webhooks:** signature header, batch envelope, headers (`X-Webhook-Attempt` carries the attempt number) and the retry policy (exponential backoff with jitter, 1 s doubling to a 1 hour cap, then hourly for up to about 48 hours, then the dead-letter queue; `at_most_once` makes one attempt) match api-inventory.md sections 5.1 to 5.3. The signature wording is in the answers log (question 10).

## Sandbox check, 2026-11-10 (our key, read-only)
To see which published view is right, we called the live sandbox with calls that create nothing (reads, the documented side-effect-free quotes, and bodies the server rejects):
- **All 17 requests that only `2sBYArTsS6` lists exist in the sandbox**, each exercised without creating anything. A route that does not exist answers `NotFoundException: Cannot GET ...`; these answer `NotExistError` (the id is unknown) or `ValidationError` (the body is wrong):
  - counterparties: list (200), get (404 `NotExistError`), create (400, wants `routingNumber`, `accountNumber`, `accountType`, `type`), update address (400, "address is required ... enables wire payments"), delete (404 `NotExistError`);
  - payments: list (200), get (404), cancel (404);
  - quotes: ACH and wire (400, both want `data.amount`);
  - sandbox simulate (400, `"data" is required`);
  - the four origination types on `POST /chapters/{id}/payments`: `ach`, `achCounterparty`, `wire` and `wireCounterparty` each answer 400 "At least one payment is required" for an empty list (the two ACH and two wire requests in the Postman list are these types of one route). The server's own message names a fifth type, `book`, which both views document and which is not one of the 17;
  - the two webhook event-type examples are the one `GET /webhooks/event-types` (200).
- **`userPaysFees`, which only `2sBXwnuYMb` documents, exists too**: a collection create with `userPaysFees: "x"` answers `"data.userPaysFees" must be a boolean`. It makes the payer pay the processing fee on top of the amount (default: the chapter absorbs it), which is what REQ-INS-023 (fees billed to US funders) needs; the adapter does not send it yet.
- **There is no Related Entities, FX, exchange-rate, ILS quote or wallet route** (`GET /related-entities`, `/fx`, `/exchange-rates`, `/chapters/{id}/payments/quotes/ils`, `/chapters/{id}/wallets`, `/me`, `/partners/me` all answer `Cannot GET`).
- So the sandbox is a superset of both published views; each view is accurate for what it lists and incomplete. A sandbox is not production: whether a partner on our tier may use counterparties and ACH or wire origination in production (the docs name a 403 `COUNTERPARTIES_NOT_ENABLED`) is still question 24.
- The 409 behaviour was provoked later the same day with writes (next section), so it is observed for ACH payment creates.

## Sandbox writes, 2026-11-10 (our key, Active and Approved chapter `f3ff4984`)
Each of these created sandbox data (left behind: counterparty 2405860, ACH payments 17067126 and 17067127, $1.00 each, $2.49 fee each).
- **Same key, same body:** the second call returns the first payment (201, same id). One payment.
- **Same key, different body** (amount 250 after 100): 201 with the **original** payment (amount 100). No error, no second payment. Crowded replays the stored result whatever the new body says, so a caller must compare the amount it gets back with the amount it sent. Our adapter derives the key from the transfer key, so a changed body under one key cannot happen on our side.
- **Concurrent, same key** (6 simultaneous requests): one created the payment, five answered `409 ConflictException`, message `DUPLICATE_REQUEST: A payment with this idempotency key is already being processed`. Exactly one payment exists afterwards. This is the case T-0695 retries.
- **Fee:** `applyFee` is required on ACH; an originated ACH of $1.00 charges a $2.49 fee, `totalDebit` 349 (matches the doc example).
- **Counterparty create** needs `nickname`, `type` `Business` or `Person`, `accountType` `Checking` or `Savings` (capitalised) and an `idempotencyKey`.
- **Sub-accounts:** `POST /chapters/{id}/subaccounts` answers `401 UnauthorizedUser` on this chapter (question 24). Not tested: book payments and the sub-account fund call.
- **One token, several organizations:** the same key lists and creates several organizations (the probes of 2026-11-09 and Israel Global Pay), so the API does not need the Related Entities dashboard.

## Sub-accounts, 2026-11-10 (after Crowded switched them on)
- `POST /chapters/{id}/subaccounts` in owner mode (fake owner, `example.com` email) answers **201** with the sub-account (`parentChapterId`, `status: Active`, the owner as an Active user). It appears in `GET /chapters` as its own chapter and has its own open account (`GET /chapters/{subId}/accounts`: own account number, same routing number, balance 0). There is no `GET .../subaccounts` list route (404).
- **Quota:** our sandbox allowed two sub-accounts at first: the third create answered `429 SubscriptionQuotaExceededError` "Limit has already been reached" (question 22). Crowded set a custom amount the same evening ("should be able to have full access now") and a third create then answered 201 (2026-11-10, 21:23).
- **A replay never returns the first sub-account.** The same key and the same body, sent again, answered **500** `InternalServerErrorException` (observed after the quota was lifted, and no second sub-account was created); while the quota was full it answered 429, because the quota is checked before the idempotency lookup. So a sub-account create whose outcome is unknown must be looked up by name (`GET /chapters?search=<name>` lists sub-accounts as chapters; the search works), never retried under the same key hoping for the original. Our adapter does not do that yet: T-0696.
- **Same key, different body** answered `500 InternalServerErrorException` (not a replay, unlike ACH payments, which replay the original). Our adapter derives the key from the transfer key, so the body never changes under a key.
- Left in the sandbox: sub-accounts 870fbf10 and cda34a3b (with owners `probe-sub@example.com` and `probe-sub2@example.com`); there is no delete route we know of.

## Reading their API docs
Crowded's docs are a Postman collection. `node tools/crowded-docs.mjs` fetches every published view and renders it to markdown, so a question about their API is answered by grep and cited by line, not from memory:
[postman-2sBXwnuYMb.md](postman-2sBXwnuYMb.md) (the link Crowded sent on 2026-11-10, 68 requests) and [postman-2sBYArTsS6.md](postman-2sBYArTsS6.md) (85 requests, published 2026-08-20; api-inventory.md was written from it).
`node tools/crowded-docs.mjs --check` fails when Crowded changes either view. The WebFetch tool cannot reach `documenter.gw.postman.com`; curl and Node can (in the cloud sandbox Node needs `NODE_USE_ENV_PROXY=1` and `NODE_EXTRA_CA_CERTS=/root/.ccr/ca-bundle.crt`).
The two views differ by 17 requests (question 24): the Counterparties folder, ACH and wire origination, quotes, get, list and cancel payment, the sandbox payment simulate, and two webhook event-type examples exist only in `2sBYArTsS6`. Neither view is a superset: `2sBXwnuYMb` has text the other lacks (`userPaysFees` on collections, the rejection rule on book payments), so compare both before relying on one.

## Program proposal, November 2026 (checked 2026-11-10)
*Israel Global Pay x Crowded: Entity structure, flow of funds and commercials for a multi-entity US to Israel program* (12 slides, a draft for discussion, written by Crowded). Checked against this file, api-inventory.md, both Postman views and the adapter.

**Agrees with what we have**
- *Arithmetic.* Every figure recomputes: the platform fee table (a $500 credit per full $1M of qualifying volume, $0 from $30M), the 2.325% balance share (60% of the 3.875% Fed funds midpoint on 2026-10-28), the illustrative month ($30,375 net) and all three scenarios (-$4,078, +$28,688, +$116,063 a month).
- *First-party funding only* matches the API (no ACH debit, inventory item 26) and question 18's caution.
- *Sub-accounts* share the parent's EIN, get their own deposit account and are limited by the subscription tier (the API answers 429; question 22). The proposal's "project sub-accounts" under the scholarship nonprofit fit that.
- *Visa debit cards, wallet and per diem accounts, hosted application and a KYB for every entity* match the API and our hosted-application flow.
- *ILS wallets and local payouts* are "NEXT, dates confirmed at signing": neither Postman view has an ILS, FX or payout-to-Israel call, every amount is cents in USD, and the adapter refuses other currencies. Nothing to build until it is live and documented (T-0656).

**Differs from what we have, or needs a decision**
1. **Zuz LLC is new.** Our notes make "Israel Global Pay, LLC" the holder (setup A). The proposal makes Zuz LLC the operator that manages and takes the revenue share, with every yeshiva rep office its own US 501(c)(3) under it: that is setup B (the institution's own entity) plus an operator, not A and not C. Decide whether Zuz LLC and Israel Global Pay, LLC are the same company, then update the setups table.
2. **The Related Entities dashboard is not in the API** (question 25). Our adapter creates an organization and a chapter per entity under one partner token; the proposal has each nonprofit "opened via the dashboard" and managed from one login.
3. **Revenue timing contradicts our 2026-11-04 notes** (question 26): the proposal pays Zuz LLC monthly into a revenue share account with a statement per entity; our notes had float and interchange credited nightly to the holder's account. If the proposal is right, the nightly unexplained-credit risk above (T-0618, T-0654, question 21) goes away. **Crowded (2026-11-10): monthly or quarterly, not nightly (to be double-confirmed), so the proposal is right and the nightly-credit reading of the recording is wrong.**
4. **The economics note is stale.** We recorded float of "about 2.5%"; the proposal's rate is 2.325% (60% of 3.875%), moving with the Fed target. New: the $15,000 monthly platform fee with volume credits. On the proposal's own mix (50% of flow held as balance, 30% spent on cards) the program loses money until about $3.5M a month of flow (net -$109 at $3.5M, +$1,383 at $3.75M); Israel Global Pay's own start estimate of $2-3M a month is a loss of about $49K a year.
5. **Third-party payments are the open risk.** REQ-INS-023 has US parents pay fees on Crowded's hosted payment page into the account held for the institution. The proposal's compliance slide says "first-party funding: push payments from the owner's own funds, no third-party pulls", and its high scenario "requires compliant third-party payments (Phase 2)". Donors paying a nonprofit by gift are fine; parents paying fees through a platform are the case question 18 asks about. Keep `institutions.usBanking` off for REQ-INS-023 until it is answered.
6. **Student per diem accounts overlap Kesher's own product.** The scholarship nonprofit funds student per diem accounts, in ILS and other currencies, on a schedule, with debit cards: the use case of Kesher's wallet, card and allowances (ADR-006 processor). Our notes say Kesher never holds a student's personal balance on Crowded. Decide whether this is a competing path or a complement before any per diem work (README "Cards" row).
7. **Phase 2 MSB is a separate program.** US to Israel transfers by third parties need their own entity, FinCEN registration and bank approval, "never commingled with nonprofit funds". Any Crowded ILS route evaluated in T-0656 must sit on that program, not on the nonprofit accounts.
8. **KYB depth.** The proposal asks for "full disclosure of prior business history" for each entity. Our KYB documents cover beneficial owners (docs/bank-review/institution-kyb.md) but nothing in our docs or specs mentions prior business history: check REQ-INS-010/011 evidence against it.
9. **Tagging and traceability.** "Each transfer tagged and exportable" and "traceable from gift to student" rest on our own KC- reference in the payment `addenda` (up to 80 characters) or `description` (10 for an ACH, 50 for a wire) and our ledger: the API has no metadata field on payments or applications.

## Webhook registration
`node tools/crowded-webhooks.mjs list | create --url … | delete --id … --yes`, with `--dry-run` to print the request
with the token and secret redacted. Run by a person on the desktop, never from CI. It needs `CROWDED_BASE_URL`,
`CROWDED_API_TOKEN` and `CROWDED_WEBHOOK_SECRET` in the environment; none is ever printed. Crowded has no test
delivery in sandbox: use the replay endpoint on a delivered event to exercise the receiver.

## Run it locally (no sandbox key needed)
The Crowded HTTP simulator (T-0660, `apps/simulators/src/crowded-http.ts`) serves the in-memory Crowded under
`/crowded/api/v1` and signs and POSTs webhook batches to the URL registered with it. One command runs the whole
US-banking flow against it: the API on `PROVIDER_INSTITUTION_BANKING=crowded`, the real registration script, the link,
fee, ACH and wrong-signature cases:

```
pnpm --filter @kesher/api exec vitest run src/institutions/us-banking.e2e.test.ts
```

To point the registration script at a simulator you started yourself, pass `--simulator`: it is the only way it accepts
an `http://localhost` base URL, and an `http://localhost` receiver URL only when the base URL is localhost too (the
receiver URL's shape is the same for both schemes: host, optional `/v1`, then `/webhooks/crowded`). The secret's name
here is `CROWDED_WEBHOOK_SECRET`, singular, as above.
The simulator's control panel (`/`, when the Crowded simulator is mounted) can decide an application, pay a collection,
settle or return an ACH, send a batch again, hold batches and release them newest first, and sign with a wrong key.
