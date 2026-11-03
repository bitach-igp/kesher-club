# Crowded (US nonprofit banking) — vendor notes

**Role in Kesher:** optional, Phase 2. Banking for an institution's US nonprofit ("American Friends of …"
501(c)(3)) that collects tuition and fees from US parents. Crowded holds the institution's own money at
i3 Bank; Kesher never holds a student's personal balance there. Behind `InstitutionBankingPort`, flag
`institutions.usBanking` (default off). Requirements REQ-INS-022 to REQ-INS-026; cards T-0647 to T-0655.

- Full endpoint inventory: [api-inventory.md](api-inventory.md) (79 operations, read 2026-11-03).
- Sandbox: `https://sandbox-api.crowdedfinance.com/api/v1`. Production host: not documented.

## How Crowded maps onto Kesher

| Crowded | Kesher | Notes |
|---|---|---|
| Organization | The institution's US entity | One per institution; created by us as partner, or self-onboarded through an onboarding link |
| Chapter | The entity's banking unit | Holds the account, contacts, collections, counterparties, the bank application |
| Application (hosted form) | The bank's own KYB of the US entity | Separate from and additional to our KYB (REQ-INS-010/011) |
| Contact | A US funder (parent) paying a fee | Created by mobile; placeholder mobiles can't receive SMS |
| Collection + Intent | A fee billed to funders (I08) | Intent's `paymentUrl` is the hosted payment page; card or ACH |
| Counterparty + ACH origination | Funding the Kesher master account | ACH credit to Kesher's US collection account, KC- reference in `addenda` |
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

## Open questions for Crowded (blocking first)
1. **Credentials:** how a partner is issued `api_token` / `partner_jwt`, their lifetime, refresh and scopes; the sandbox sign-up process; the production base URL.
2. **American Friends entities:** will you bank a 501(c)(3) whose programs run in Israel, with an Israeli parent organisation?
3. **Webhook signature:** raw body or re-stringified JSON? Is a timestamp or replay window planned?
4. **ACH event names:** are `finance.ach_payment.*` / `finance.wire_payment.*` subscribable today (they're missing from the event-types list)?
5. **Amounts:** collect payment `amount` is gross in REST and net in webhooks: which is right? Unit of `standardAmount` and of subaccount `fund.amount`?
6. **Idempotency:** behaviour on a reused key with a different body; retention beyond ~48 h; dedupe on organization/chapter/contact/collection creates.
7. **Collections:** sandbox simulation of card and ACH collection outcomes (none documented); refund completion event (`collect.refund.completed` isn't listed).
8. **Rate limits:** headers and the 429 body for the 1,000/min limit; retry guidance for 5xx.
9. **Partner economics:** fees per account, collection and ACH; platform charges and `move-fees` for revenue share.
10. **Data:** why `accountNumber` is returned unmasked; data-processing terms; data retention.
