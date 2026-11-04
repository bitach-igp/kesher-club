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
| 10 Webhook signature | Zvi | — | — | — |
| 11 ACH event names | Zvi | — | — | — |
| 12 ILS API | Zvi | — | — | — |
| 13 Amounts | Zvi | — | — | — |
| 14 Idempotency | Zvi | — | — | — |
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
22. **Sub-account quota:** how many sub-accounts does our subscription tier allow (the API answers 429 over it)?
23. **Shekel payout partner:** exact name and licence of the conversion and local payout partner (transcribed as "Tunes", Wise also named).

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
