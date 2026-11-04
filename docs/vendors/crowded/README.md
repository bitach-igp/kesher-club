# Crowded (US banking, ILS transfers coming) — vendor notes

**Role in Kesher:** optional, Phase 2. US banking (at i3 Bank) for collecting fees from US parents and funding
master accounts by ACH, behind `InstitutionBankingPort`, flag `institutions.usBanking` (default off).
Requirements REQ-INS-022 to REQ-INS-026; cards T-0647 to T-0656. Kesher never holds a student's personal
balance there.

**What Ezra learned (2026-11-02 office demo, not yet in writing):**
- Crowded is not limited to nonprofits. A regular company can sign up as long as its business is related to
  Israel, so **Israel Global Pay, LLC** can be the account holder.
- Crowded runs a general nonprofit under its own umbrella that institutions without a 501(c)(3) can work under.
- **ILS transfers are due in 4–6 weeks.** If they pay Israeli accounts, Crowded could be a USD→ILS route as well
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
| Cards (wallet / perdiem) | Not used | US shipping only, no spend-control API, non-US cardholders unconfirmed |

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

| # | Owner | Sent | Answered | Answer |
|---|---|---|---|---|
| 1 ILS transfers | Zvi | 2026-11-03 | — | — |
| 2 Account structure | Zvi | 2026-11-03 | — | — |
| 3 Who is the customer | Ezra | — | — | — |
| 4 "Related to Israel" | Ezra | — | — | — |
| 5 Economics | Ezra | — | — | — |
| 6 ILS timing | Ezra | — | — | — |
| 7 Umbrella nonprofit | Ezra | — | — | — |
| 8 Students | Ezra | — | — | — |
| 9 Credentials | Zvi | — | — | — |
| 10 Webhook signature | Zvi | — | — | — |
| 11 ACH event names | Zvi | — | — | — |
| 12 ILS API | Zvi | — | — | — |
| 13 Amounts | Zvi | — | — | — |
| 14 Idempotency | Zvi | — | — | — |
| 15 Sandbox | Zvi | — | — | — |
| 16 Rate limits | Zvi | — | — | — |
| 17 Data | Zvi | — | — | — |

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
