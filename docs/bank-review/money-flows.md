# Money flows

Every way money moves in Kesher Club, as the code at commit `fb4c6de` books it. Each flow names its
sequence diagram (SEQ id, live spec Tab 3 §7), its requirements (REQ ids, Tab 3 §2-3), its ledger
postings, its idempotency key, the tests that prove it, and the screen recording the desktop request
`handoff/desktop/T-0912-flow-recordings.md` captures.

Amounts in code are integers in minor units: cents for USD, agorot for ILS. This document shows both,
for example ₪500.00 (50,000 agorot).

## At a glance

| # | Flow | SEQ | REQ | Tests | Recording |
|---|---|---|---|---|---|
| 1 | Load by card, Apple Pay, Google Pay | SEQ-02 | REQ-WAL-002, REQ-LED-003 | TST-WAL-002 | REC-01 load by card |
| 2 | ACH load with bank hold and release | SEQ: not in Tab 3 §7 | REQ-WAL-002, REQ-WAL-003 | TST-WAL-003 | REC-02 ACH load hold and release |
| 3 | Load into the other purse at the club rate | SEQ: not in Tab 3 §7 | REQ-WAL-006, REQ-FX-003, REQ-FX-004 | TST-WAL-006 | REC-03 load into the other purse |
| 4 | Auto-reload | SEQ: not in Tab 3 §7 | REQ-WAL-004 | TST-WAL-004 | REC-04 auto-reload |
| 5 | P2P send, same currency | SEQ-06 | REQ-PAY-001, REQ-PAY-002, REQ-PAY-005 | TST-PAY-001, TST-PAY-002, TST-PAY-005 | REC-05 P2P send |
| 6 | P2P new-counterparty hold, cancel, release | SEQ-06 | REQ-PAY-003 | TST-PAY-003 | REC-06 P2P new-pair hold |
| 7 | P2P send across currencies | SEQ-06 | REQ-PAY-006, REQ-PAY-007, REQ-FX-002, REQ-FX-003 | TST-PAY-006, TST-PAY-007 | REC-07 P2P cross-currency send |
| 8 | Payment requests and splits | SEQ: not in Tab 3 §7 | REQ-PAY-004 | TST-PAY-004 | REC-08 requests and splits |
| 9 | Send or load proposed by an AI assistant | SEQ-04 | REQ-AGT-006 | TST-AGT-006 | REC-09 assistant-proposed send |
| 10 | FX conversion between purses | SEQ-08 | REQ-FX-001, REQ-FX-002, REQ-FX-003, REQ-FX-004 | TST-FX-001 to TST-FX-004 | REC-10 FX conversion |
| 11 | Club rates: published rate and two-person manual rate | SEQ: not in Tab 3 §7 | REQ-FX-003, REQ-FX-004, REQ-ADM-003 | TST-FX-003, TST-FX-004, TST-ADM-003 | REC-11 club rates |
| 12 | Card authorisation (JIT) and settlement | SEQ-01 | REQ-CRD-003, REQ-CRD-004, REQ-CRD-005, REQ-CRD-008 | TST-CRD-003, TST-CRD-004, TST-CRD-008 | REC-12 card authorisation |
| 13 | Payout to an Israeli bank account | SEQ-09 | REQ-PO-001, REQ-PO-002 | TST-PO-001, TST-PO-002 | REC-13 payout |
| 14 | Institution allowance run | SEQ-07 | REQ-INS-003, REQ-INS-004 | TST-INS-003, TST-INS-004 | REC-14 allowance run |
| 15 | Institution collections (fee payment) | SEQ: not in Tab 3 §7 | REQ-INS-006 | TST-INS-006 | REC-15 collections |
| 16 | Add-on purchase (eSIM, insurance) | SEQ-10 | REQ-MKT-001, REQ-ESIM-002, REQ-INSR-001 | TST-MKT-001, TST-ESIM-002 | REC-16 add-on purchase |
| 17 | Account closure refunds | SEQ: not in Tab 3 §7 | REQ-WAL-005 | TST-WAL-005 | REC-17 closure refunds |
| 18 | Reversals and ledger corrections | SEQ: not in Tab 3 §7 | REQ-LED-001, REQ-LED-002, REQ-LED-003 | TST-LED-001 to TST-LED-003 | REC-18 ledger reversals |

SEQ-03 (card push provisioning) and SEQ-05 (onboarding and KYC) move no money and are not listed.
The recordings are of the test suites named under each flow running against the local simulators;
the request explains why (no mobile build or running API exists yet).

## How every flow is booked

These controls hold for every journal below.

- One journal per money event, balanced per currency. `post()` refuses a journal with fewer than two
  postings, a zero posting, two postings to one account, or any currency that does not sum to zero
  (`apps/api/src/ledger/post.ts:136-147`). A deferred database trigger checks the same at commit
  (`db/migrations/ledger/0001_init.sql:47-56`). Proved by TST-LED-001
  (`apps/api/src/ledger/post.test.ts:41`, `:49`).
- Insert-only. The application role cannot update, delete or truncate ledger rows
  (`db/migrations/ledger/0001_init.sql:89-91`). Proved by TST-LED-002 (`apps/api/src/ledger/post.test.ts:71`).
- Idempotent. Every journal has a unique idempotency key (`db/migrations/ledger/0001_init.sql:21`); a
  second post with the same key returns the first journal unchanged
  (`apps/api/src/ledger/post.ts:45-46`). Proved by TST-LED-003 (`apps/api/src/ledger/post.test.ts:94`, `:102`).
- Corrections are reversing journals. `reverse()` posts the negated postings with kind `reversal`
  (`apps/api/src/ledger/post.ts:89-94`); a journal can be reversed once (`db/migrations/ledger/0001_init.sql:24`).
- Sign convention. A positive posting is a debit and a negative one a credit
  (`apps/api/src/institutions/export.ts:86`). Member `wallet` and `pending` accounts are credit-normal:
  a credit is money the member gains (`apps/api/src/ledger/accounts.ts:3-6`, `:17`). Below, "Dr" is a
  positive posting and "Cr" a negative one.
- Accounts. Each member has a `wallet` and a `pending` account in USD and in ILS
  (`apps/api/src/ledger/accounts.ts:43-49`). Available = wallet; holds = pending
  (`apps/api/src/ledger/accounts.ts:3-5`). System accounts (`partner_settlement`, `fx_position`,
  `fee_income`, `institution_master`, `addon_payable`, `suspense`, `interchange_income`) have one row per
  currency under a single system owner (`apps/api/src/ledger/accounts.ts:12`, `:15`, `:55-57`).
- Transfers. Member-facing movements are rows in `ops.transfer`, moved through one state machine:
  created → submitted → settled, or held, released, failed, cancelled, reversed
  (`apps/api/src/transfers/state-machine.ts:12-21`). Any other transition is refused
  (`apps/api/src/transfers/state-machine.ts:25-29`). A replayed create returns the existing transfer
  (`apps/api/src/transfers/service.ts:79-102`).
- Vendor ids are stored in `ops.external_ref`, never on the transfer (`db/migrations/ledger/0001_init.sql:62`;
  for example `apps/api/src/wallet/loads.ts:194`).
- Night controls. A balance proof compares every cached balance with its postings and opens a case per
  break (`apps/worker/src/ledger/balance-proof.ts:1-4`; tests `apps/worker/src/ledger/balance-proof.test.ts:31`, `:40`).
  Reconciliation matches partner records to journals and opens a case for any break before 06:00
  Israel time (`apps/worker/src/recon/recon.ts:1-4`; TST-LED-004, `apps/worker/src/recon/recon.test.ts:48`).
- Money actions need a passkey step-up younger than 5 minutes (REQ-AUTH-006), checked by each money
  handler, for example `apps/api/src/wallet/handlers.ts:18` and `apps/api/src/p2p/handlers.ts:58`.
- Every money feature is behind a flag that is off in production by default: `wallet.enabled`,
  `funding.ach`, `p2p.enabled`, `fx.enabled`, `payouts.nium`, `institutions.money`, `mcp.money.propose`
  (`config/flags.json:73-77`, `:150-154`, `:122-126`, `:129-133`, `:136-140`, `:143-147`, `:178-182`).

Gap found: Tab 3 §7 names workflow keys with a prefix (`load:{key}` in SEQ-02, `transfer:{key}` in SEQ-06,
`fx:{quoteId}` in SEQ-08, `payout:{key}` in SEQ-09). The code uses the member's Idempotency-Key as
it arrives (`apps/api/src/wallet/loads.ts:165`, `apps/api/src/p2p/send.ts:130`,
`apps/api/src/fx/service.ts:141`, `apps/api/src/payouts/service.ts:151`). The engineering lead decides
whether the spec or the code changes.

Decided (ADR-014, decision 3): the workflow id is the Idempotency-Key as received; the spec follows the code.

---

## 1. Load by card, Apple Pay or Google Pay

A member, or a funder for a member they fund, tops up a purse through the funding provider. Money
lands only when the provider confirms the payment.

| SEQ | REQ | Flag | Recording |
|---|---|---|---|
| SEQ-02 | REQ-WAL-002, REQ-LED-003 | `wallet.enabled` (`apps/api/src/wallet/loads.ts:163`) | REC-01 load by card |

Steps as coded:
- Methods: card, Apple Pay, Google Pay (`apps/api/src/wallet/loads.ts:38`). A funder may load only a
  member with an active membership they fund (`apps/api/src/wallet/loads.ts:380-383`).
- The transfer (kind `load`) is created and submitted; the provider pull carries the workflow id as its
  idempotency key (`apps/api/src/wallet/loads.ts:172-191`).
- A decline fails the transfer and posts nothing (`apps/api/src/wallet/loads.ts:113`). An outage leaves
  it submitted for a retry with the same key (`apps/api/src/wallet/loads.ts:114-115`). The worker asks
  the provider about loads still submitted after 10 minutes (`apps/worker/src/wallet/load-workflow.ts:10-12`).
- Provider webhooks settle or fail the transfer once; a repeat changes nothing
  (`apps/api/src/wallet/loads.ts:272-282`).

| Journal kind | Key | Dr | Cr | Currency |
|---|---|---|---|---|
| `load` | `{Idempotency-Key}:settle` | `partner_settlement` | member `wallet` | the load's currency |

Source: `apps/api/src/wallet/loads.ts:197-208`, `:336-341`. Example from the test: a $100.00 Apple Pay
load (10,000 cents) posts Dr `partner_settlement` USD 10,000, Cr member wallet USD 10,000
(`apps/api/src/wallet/loads.test.ts:65`).

Idempotency: the member's Idempotency-Key is the workflow id, the transfer key and the provider pull key;
the journal key is `{key}:settle` (`apps/api/src/wallet/loads.ts:2-6`, `:137`).

Tests: TST-WAL-002 in `apps/api/src/wallet/loads.test.ts:56-151` (settle, replay, decline, outage),
`:153-174` (webhooks), `:249` (payment sheet), and `apps/worker/src/wallet/load-workflow.test.ts:76-189`.

Gap found: SEQ-02 shows a program funding transfer to the processor or bank before the journal posts. The
code posts on the funding provider's confirmation and calls no bank or processor
(`apps/api/src/wallet/loads.ts:197-208`). This waits on the processor and bank choice (ADR-006); the
founder decides with the bank.

Decided (ADR-014, decision 4): the ledger stays a shadow until ADR-006 picks the processor; the funding transfer then arrives as a port call before the journal.

## 2. ACH load with bank hold and release

A bank (ACH) load is held for the bank's hold days. The member sees it as pending until the release
date, then it moves to the spendable purse.

| SEQ | REQ | Flag | Recording |
|---|---|---|---|
| SEQ: not in Tab 3 §7 | REQ-WAL-002, REQ-WAL-003 | `funding.ach` (`apps/api/src/wallet/loads.ts:368`) | REC-02 ACH load hold and release |

- The provider answers `on_hold` with a release date. The simulator holds 3 business days, Monday to
  Friday (`packages/ports/src/funding.simulator.ts:11-23`, `:48`).
- A provider confirmation during the hold leaves the load held (`apps/api/src/wallet/loads.ts:125-126`).
- The worker's release job runs every 5 minutes and releases each hold whose date has passed
  (`apps/worker/src/wallet/release-holds.ts:9`, `:31-36`).
- An ACH return during the hold reverses the hold journal and fails the load
  (`apps/api/src/wallet/loads.ts:245-248`).

| Journal kind | Key | Dr | Cr | Currency |
|---|---|---|---|---|
| `load_hold` | `{key}:hold` | `partner_settlement` | member `pending` | load currency |
| `load_release` | `{key}:release` | member `pending` | member `wallet` | load currency |
| `reversal` (on return) | `{key}:hold:reversal` | member `pending` | `partner_settlement` | load currency |

Source: `apps/api/src/wallet/loads.ts:210-221`, `:220-240`, `:242-245`; keys `:138-139`.

Tests: TST-WAL-003 in `apps/api/src/wallet/loads.test.ts:175`, `:197` and
`apps/worker/src/wallet/release-holds.test.ts:47`, `:86`, `:114`.

Open: the real hold days come from the bank's hold policy; the code takes the date the provider returns
(`apps/api/src/wallet/loads.ts:130`). The flag's turn-on condition is "Bank hold policy; Plaid contract"
(`config/flags.json:150-154`). The bank sets the days.

## 3. Load into the other purse at the club rate

A load paid in one currency can credit the other purse. It is priced once, when it begins, at the
club rate less the purse owner's plan markup, like every conversion (ADR-014, decision 2).

| SEQ | REQ | Flag | Recording |
|---|---|---|---|
| SEQ: not in Tab 3 §7 | REQ-WAL-006, REQ-FX-002, REQ-FX-003, REQ-FX-004 | `wallet.enabled` | REC-03 load into the other purse |

- Price: the club rate for the pair, less the purse owner's plan markup in basis points
  (`apps/api/src/wallet/loads.ts:324-333`). With no valid club rate the load is refused with
  PROVIDER_UNAVAILABLE before the provider is asked (`apps/api/src/wallet/loads.ts:327`;
  `apps/api/src/fx/rates.ts:125-130`).
- The price rides on the transfer; a replay or late webhook never re-prices
  (`apps/api/src/wallet/loads.ts:173-175`). The journal metadata carries the rate version, the markup in
  basis points and all three amounts (`apps/api/src/wallet/loads.ts:418-431`).

| Journal kind | Key | Postings |
|---|---|---|
| `load` | `{key}:settle` | Dr `partner_settlement` (load currency); Cr `fx_position` (load currency); Dr `fx_position` (purse currency, gross); Cr member `wallet` (purse currency, credited); Cr `fee_income` (purse currency, markup, when above zero) |

Source: `apps/api/src/wallet/loads.ts:342-362`. An ACH load converts the same way into `pending`, and
the release moves the credited amount within the purse currency (`apps/api/src/wallet/loads.ts:223`).
Example: $100.00 into the shekel purse at 3.70 is ₪370.00 gross; the default 75 basis points keep ₪2.78,
so the purse is credited ₪367.22 (36,722 agorot) (`apps/api/src/wallet/loads.test.ts:335`). A member on a
25 basis-point plan keeps more (`apps/api/src/wallet/loads.test.ts:392`).

Tests: TST-WAL-006 in `apps/api/src/wallet/loads.test.ts:287-427`.

## 4. Auto-reload

A member sets, per purse, a threshold, a target and a saved payment method. When the available balance
falls below the threshold, the worker loads the difference to the target, at most once in 24 hours.

| SEQ | REQ | Flag | Recording |
|---|---|---|---|
| SEQ: not in Tab 3 §7 | REQ-WAL-004 | `wallet.enabled` (`apps/api/src/wallet/auto-reload.ts:89`) | REC-04 auto-reload |

- Setting the rule needs a fresh step-up (`apps/api/src/wallet/handlers.ts:29`).
- The worker runs every 15 minutes (`apps/worker/src/wallet/auto-reload-job.ts:7`). Below the threshold
  it claims the 24-hour window first, then loads target minus available
  (`apps/api/src/wallet/auto-reload.ts:117-141`). A failed or declined load still uses the window
  (`apps/api/src/wallet/auto-reload.ts:123-127`, `:134-137`).
- The load is an ordinary load (flow 1), in the rule's own purse currency
  (`apps/api/src/wallet/auto-reload.ts:129-133`).

Postings: as flow 1. Key: `auto-reload:{ruleId}:{claim time in ms}` (`apps/api/src/wallet/auto-reload.ts:130`),
so the journal key is that plus `:settle`.

Example: $45.00 available, threshold $50.00, target $200.00, loads $155.00 (15,500 cents) once
(`apps/api/src/wallet/auto-reload.test.ts:85`).

Tests: TST-WAL-004 in `apps/api/src/wallet/auto-reload.test.ts:85`, `:116` and
`apps/worker/src/wallet/auto-reload-job.test.ts:46`, `:72`, `:112`.

## 5. P2P send, same currency

A verified member sends money to another verified member.

| SEQ | REQ | Flag | Recording |
|---|---|---|---|
| SEQ-06 | REQ-PAY-001, REQ-PAY-002, REQ-PAY-005 | `p2p.enabled` (`apps/api/src/p2p/handlers.ts:14`, `:60`) | REC-05 P2P send |

- Both sides must hold an active account with identity verification approved
  (`apps/api/src/p2p/send.ts:151-159`).
- Limits: the lower of the plan's monthly P2P entitlement and the member's risk-tier limit, counted per
  UTC calendar month from `ops.transfer` (`apps/api/src/p2p/limits.ts:49-85`, `:96-104`). Over the
  limit answers LIMIT_EXCEEDED with the remaining amount (`apps/api/src/p2p/limits.ts:81-85`).
- Then the purse must cover the amount, else INSUFFICIENT_FUNDS (`apps/api/src/p2p/send.ts:128-129`).
- A send still submitted after 60 seconds is finished by the worker with the same keys
  (`apps/worker/src/p2p/send-workflow.ts:8-10`).

Risk-tier monthly limits (`db/migrations/ledger/0009_risk_tiers.sql:12-15`); a member without a tier is
`new` (`apps/api/src/p2p/limits.ts:14`):

| Tier | ILS | USD |
|---|---|---|
| new | ₪1,000.00 (100,000) | $300.00 (30,000) |
| standard | ₪5,000.00 (500,000) | $1,500.00 (150,000) |
| trusted | ₪20,000.00 (2,000,000) | $6,000.00 (600,000) |

| Journal kind | Key | Dr | Cr | Currency |
|---|---|---|---|---|
| `p2p` | `{key}:settle` | sender `wallet` | recipient `wallet` | send currency |

Source: `apps/api/src/p2p/send.ts:199-210`, `:222-227`. Plan usage is recorded under `{key}:usage`
(`apps/api/src/p2p/send.ts:273-275`). The recipient gets one SMS keyed `{key}:notify`, with the
amount and transfer id only (`apps/api/src/p2p/send.ts:288-297`).

Tests: TST-PAY-001 (`apps/api/src/p2p/send.test.ts:74`; `apps/worker/src/p2p/send-workflow.test.ts:69`, `:87`),
TST-PAY-002 (`apps/api/src/p2p/send.test.ts:126`; `apps/api/src/p2p/limits.test.ts:42-67`),
TST-PAY-005 (`apps/api/src/p2p/send.test.ts:104`; `apps/api/src/transfers/service.test.ts:1-2`).

Gap found: REQ-PAY-001 and SEQ-06 say settlement is a book transfer at the partner (processor). The code posts
the internal journal only and calls no processor (`apps/api/src/p2p/send.ts:199-210`), so SEQ-06's
compensation (processor failure, no journal, PROVIDER_UNAVAILABLE) has no code path yet. This waits on
ADR-006; the founder decides with the bank. The flag's turn-on condition is "Bank approves book
transfers" (`config/flags.json:122-126`).

Decided (ADR-014, decision 4): the book transfer arrives with the processor adapter, inside the send workflow before the journal, with SEQ-06's compensation; `p2p.enabled` stays off until then.

## 6. P2P new-counterparty hold, cancel and release

A first send above the threshold to someone the member has never paid waits two hours, during which the
sender can cancel.

| SEQ | REQ | Flag | Recording |
|---|---|---|---|
| SEQ-06 (the hold check step) | REQ-PAY-003 | `p2p.enabled` | REC-06 P2P new-pair hold |

- Threshold: above ₪500.00 (50,000 agorot) or $150.00 (15,000 cents) (`apps/api/src/p2p/holds.ts:13-14`).
  "New" means no settled send from this sender to this recipient in any currency
  (`apps/api/src/p2p/holds.ts:29-37`).
- The hold reserves the money for 2 hours (`apps/api/src/p2p/holds.ts:12`, `:40-56`).
- The sender may cancel while it waits; the hold journal is reversed (`apps/api/src/p2p/holds.ts:81-88`).
- The worker runs every minute and releases holds whose time has passed
  (`apps/worker/src/p2p/release-holds.ts:1-9`).

| Journal kind | Key | Dr | Cr |
|---|---|---|---|
| `p2p_hold` | `{key}:hold` | sender `wallet` | sender `pending` |
| `p2p_release` | `{key}:release` | sender `pending` | recipient `wallet` |
| `reversal` (on cancel) | `{key}:hold:reversal` | sender `pending` | sender `wallet` |

Source: `apps/api/src/p2p/holds.ts:15-18`, `:40-88`. A held cross-currency send releases at the price
fixed when it began, with the flow 7 postings drawn from `pending` (`apps/api/src/p2p/send.ts:256-271`).

Tests: TST-PAY-003 in `apps/api/src/p2p/holds.test.ts:67`, `:98`, `:132`, `apps/api/src/p2p/send.test.ts:146`
and `apps/worker/src/p2p/release-holds.test.ts:66`.

Gap found: Tab 3 §3 states the threshold in shekels only (₪500). The dollar threshold of $150.00 is the
code's choice (`apps/api/src/p2p/holds.ts:14`). Compliance confirms or sets it.

Decided (ADR-014, decision 5): ₪500 or $150; REQ-PAY-003 names both. Compliance may lower either.

## 7. P2P send across currencies

When the recipient receives in a different currency from the one sent, the send converts at the club
rate, and the recipient's plan markup is taken from the received amount.

| SEQ | REQ | Flag | Recording |
|---|---|---|---|
| SEQ-06 | REQ-PAY-006, REQ-PAY-007, REQ-FX-002, REQ-FX-003 | `p2p.enabled` | REC-07 P2P cross-currency send |

- The recipient's receiving currency (USD, ILS or as sent) decides the purse credited
  (`apps/api/src/p2p/send.ts:185-186`; TST-PAY-007, `apps/api/src/me/preferences.test.ts:27`).
- Price, fixed once when the send begins: gross at the club rate, less the recipient's plan markup
  (`apps/api/src/p2p/send.ts:184-193`). The markup is the plan's, or 75 basis points (0.75%) without
  an active plan (`apps/api/src/fx/service.ts:185-190`; `apps/api/src/billing/plans.ts:9`).
- With no valid club rate the send is refused with PROVIDER_UNAVAILABLE before anything is created
  (`apps/api/src/p2p/send.ts:13-14`, `:187`). Limits and the hold rule judge the sent amount
  (`apps/api/src/p2p/send.ts:14-15`).

| Journal kind | Key | Postings |
|---|---|---|
| `p2p` | `{key}:settle` | Dr sender `wallet` (sent currency); Cr `fx_position` (sent currency); Dr `fx_position` (received currency, gross); Cr recipient `wallet` (received currency, net); Cr `fee_income` (received currency, markup) |

Source: `apps/api/src/p2p/send.ts:229-240`. Example from the test, matching the spec's acceptance:
$100.00 (10,000 cents) at 3.70 is ₪370.00 gross (37,000 agorot); the 0.75% markup is ₪2.78 (278);
the recipient receives ₪367.22 (36,722) (`apps/api/src/p2p/send.test.ts:220-233`).

Tests: TST-PAY-006 in `apps/api/src/p2p/send.test.ts:209`, `:268`, `:293` and
`apps/worker/src/p2p/send-workflow.test.ts:136`; the screen model in
`apps/mobile/app/pay/pay.model.test.ts:242-300`.

## 8. Payment requests and splits

A member asks another for money, or splits a bill so each other participant gets a request for their
share. Paying a request runs the ordinary send.

| SEQ | REQ | Flag | Recording |
|---|---|---|---|
| SEQ: not in Tab 3 §7 | REQ-PAY-004 | `p2p.enabled` (`apps/api/src/p2p/handlers.ts:17-19`) | REC-08 requests and splits |

- A split gives equal shares to everyone but the requester, who covers the remainder; up to 20
  participants (`apps/api/src/p2p/requests.ts:13`, `:69-73`). Example: ₪200.00 four ways is three
  requests of ₪50.00 (5,000 agorot) (`apps/api/src/p2p/requests.test.ts:63`).
- Paying runs flows 5, 6 or 7 with the key `request:{requestId}:pay`, so paying twice is one transfer
  (`apps/api/src/p2p/requests.ts:75`, `:137-153`).
- A request is payable for 14 days (`apps/api/src/p2p/requests.ts:11`). The worker expires the rest
  every 15 minutes, and the API expires on read (`apps/worker/src/p2p/expire-requests.ts:1-6`;
  `apps/api/src/p2p/requests.ts:172-178`).

Postings: none at request time; the payment posts as flow 5, 6 or 7.
Keys: a request uses the member's Idempotency-Key; each request of a split uses `{key}:{index}`
(`apps/api/src/p2p/requests.ts:85-96`, `:122`).

Tests: TST-PAY-004 in `apps/api/src/p2p/requests.test.ts:63-182`; the screen model in
`apps/mobile/app/pay/pay.model.test.ts:353-402`.

## 9. Send or load proposed by an AI assistant

An assistant the member connected may propose a send or a load. It creates a pending intent; only the
member, with a passkey step-up, can approve it within 24 hours. Approval runs the same send (flows 5 to 7)
or load (flows 1 to 3) the member would start in the app, keyed `intent:{intentId}`.

| SEQ | REQ | Flag | Recording |
|---|---|---|---|
| SEQ-04 | REQ-AGT-006 | `mcp.money.propose` (`config/flags.json:178-182`); approving a send also needs `p2p.enabled`, a load `wallet.enabled` (`apps/api/src/intents/service.ts:246`, `:241`) | REC-09 assistant-proposed send |

- Proposing creates an intent that expires in 24 hours; no journal and no transfer
  (`apps/api/src/intents/service.ts:1-2`, `:24`, `:112-123`).
- Approval needs a step-up token younger than 5 minutes, from the member the intent belongs to
  (`apps/api/src/intents/service.ts:125-131`). A revoked assistant grant or a recovery hold refuses it
  (`apps/api/src/intents/service.ts:142-143`).
- A send runs `P2pSendService.send`, the `POST /transfers` path: eligibility, the monthly limit, the
  balance, the new-pair hold and the receiving-currency price of flows 5 to 7 all apply
  (`apps/api/src/intents/service.ts:246-250`; `apps/api/src/p2p/send.ts:119-130`). A send from a purse
  other than the approver's is refused (`apps/api/src/intents/service.ts:248`).
- A load runs `LoadService.request`, the `POST /loads` path. The assistant names no funding method, so
  the approval does (`contracts/openapi.yaml:884-908`, `:2245-2257`;
  `apps/api/src/intents/service.ts:240-245`; `apps/api/src/wallet/loads.ts:162-167`). The approver
  pays, into their own purse or one they fund; a load into the other purse is priced as in flow 3.
- The money runs before the intent is marked approved, so a refusal (LIMIT_EXCEEDED, INSUFFICIENT_FUNDS,
  no method, a purse the approver does not fund) leaves it pending (`apps/api/src/intents/service.ts:145-150`).
  A declined card fails the load; the intent is approved and the assistant proposes again.
- A second approval replays the first: the same transfer, the same load with the same funding choice,
  no new journal (`apps/api/src/intents/service.ts:132-133`).
- The worker expires pending intents past 24 hours every 15 minutes (`apps/worker/src/agent/expire-intents.ts:8`,
  `:24-35`; `apps/api/src/intents/service.ts:200-223`); the member's list hides them before that
  (`apps/api/src/intents/service.ts:230-234`). An intent whose money already started under its key is
  never expired: a late approval or the sweep marks it approved by the member, as of the transfer's
  creation (`apps/api/src/intents/service.ts:135-144`, `:214-216`).

Journals are those of the flow the intent runs (flows 1 to 3 for a load, 5 to 7 for a send), keyed from
`intent:{intentId}`: for example `intent:{intentId}:settle`, `:hold`, `:release`.

Tests: TST-AGT-006 in `apps/api/src/intents/service.test.ts:69`, `:78`, `:97`, `:114`, `:127`, `:142`
(sends), `:165`, `:181`, `:207` (loads), `:232`, `:239` (expiry); `apps/worker/src/agent/expire-intents.test.ts:30`.

Gap found: before T-1008, approval created the transfer in state `created` and nothing then ran the send.
The worker only finishes sends that are `submitted` (`apps/api/src/p2p/send.ts:278-279`), so no journal
posted and the limit, eligibility and balance checks of flow 5 were not applied. SEQ-04 shows
`start(transfer:{intentId})`.

Decided (ADR-014, decision 6): approval runs the member's own send path. Built in T-1008; T-1009 does the
same for loads and T-1010 adds the expiry sweep. `mcp.money.propose` still waits on "Bank sign-off on
agent intent flow" (`config/flags.json:182`).

## 10. FX conversion between purses

A member converts between their own USD and ILS purses at a quote that holds for 30 seconds.

| SEQ | REQ | Flag | Recording |
|---|---|---|---|
| SEQ-08 | REQ-FX-001, REQ-FX-002, REQ-FX-003, REQ-FX-004 | `fx.enabled` (`apps/api/src/fx/service.ts:91`, `:107`) | REC-10 FX conversion |

- Quote: the club rate gives the gross; the plan markup (75 basis points by default) is taken from it;
  total = gross − markup; it expires after 30 seconds (`apps/api/src/fx/service.ts:27`, `:92-97`).
  The purse must cover the amount (`apps/api/src/fx/service.ts:98-99`).
- Convert: an expired or unknown quote answers QUOTE_EXPIRED and moves nothing
  (`apps/api/src/fx/service.ts:126-131`). The provider is asked for its own fill under the same key, as
  the club's hedge (`apps/api/src/fx/service.ts:143-147`). A vendor reject fails the conversion and voids
  the quote with no journal; an outage leaves it submitted for a retry with the same key while the quote
  lives, and a retry after the quote is gone fails it (`apps/api/src/fx/service.ts:148-156`, `:126-136`). The
  worker's sweep fails any conversion still submitted once its quote cannot be alive
  (`apps/api/src/fx/service.ts:164-182`; `apps/worker/src/fx/void-stale.ts:15-26`). Tests: T-0520 in
  `apps/api/src/fx/service.test.ts:187-260` and `apps/worker/src/fx/void-stale.test.ts`.
- The journal metadata carries the markup in basis points, the club rate version and the provider's
  fill (`apps/api/src/fx/service.ts:218-230`).

| Journal kind | Key | Postings |
|---|---|---|
| `fx` | `{key}:settle` | Dr member `wallet` (from); Cr `fx_position` (from); Dr `fx_position` (to, gross); Cr member `wallet` (to, total); Cr `fee_income` (to, markup) |

Source: `apps/api/src/fx/service.ts:198-232`. Example from the test: $100.00 at a club rate of 3.71 is
₪371.00 gross (37,100 agorot); the 0.75% markup is ₪2.78 (278); the member receives ₪368.22 (36,822)
(`apps/api/src/fx/service.test.ts:105-121`).

Tests: TST-FX-001 (`apps/api/src/fx/service.test.ts:62-78`; `apps/mobile/app/convert/fx.model.test.ts:67-115`),
TST-FX-002 (`apps/api/src/fx/service.test.ts:104-147`), TST-FX-003/004 (`apps/api/src/fx/service.test.ts:163`).

Gap found: quotes are held in process memory, so a restart forgets them and the member is asked for a fresh
quote (`apps/api/src/fx/service.ts:7-9`, `:75-76`). The engineering lead confirms this is acceptable
when more than one API instance runs.

Decided (ADR-014, decision 8): acceptable while one API instance runs; quotes move to a table before a second. Card T-0522.

Gap found: SEQ-08's compensation is "provider reject, quote void, no journal". Before T-0520 a provider
error left the transfer `submitted`, and no worker sweep finished or failed submitted FX transfers.

Decided (ADR-014, decision 7): a vendor reject fails the transfer and voids the quote; a stale submitted
conversion is failed by a sweep. Built in T-0520 (see the Convert line above).

## 11. Club rates: published rate and two-person manual rate

No money moves here, but every conversion above prices from this rate.

| SEQ | REQ | Flag | Recording |
|---|---|---|---|
| SEQ: not in Tab 3 §7 | REQ-FX-003, REQ-FX-004, REQ-ADM-003 | none in code | REC-11 club rates |

- One active rate per pair, versioned; the reverse direction is derived from the same row
  (`apps/api/src/fx/rates.ts:1-7`, `:101-106`).
- The worker publishes the FX provider's mid-rate every 5 minutes, valid for 15 minutes
  (`apps/worker/src/fx/refresh-rates.ts:1-10`; `apps/api/src/fx/rates.ts:19`, `:147-158`). A rate past
  its window is not used (`apps/api/src/fx/rates.ts:116-122`).
- Finance may propose a manual rate with a reason; the proposer counts as the first approver and a
  second, different finance user activates it; activation writes an audit entry
  (`apps/api/src/fx/rates.ts:164-188`, `:202-212`; `apps/api/src/approvals/service.ts:52`, `:95`). While a
  manual rate is active the worker publishes nothing (`apps/api/src/fx/rates.ts:151`).

Tests: TST-FX-003 (`apps/api/src/fx/rates.test.ts:62-71`), TST-FX-004
(`apps/worker/src/fx/refresh-rates.test.ts:25-56`), TST-ADM-003 (`apps/api/src/fx/rates.test.ts:95-129`).

## 12. Card authorisation (JIT) and settlement

When a member pays by card, the processor asks us to approve or decline inside its time budget. An
approval reserves the money.

| SEQ | REQ | Flag | Recording |
|---|---|---|---|
| SEQ-01 | REQ-CRD-003, REQ-CRD-004, REQ-CRD-005, REQ-CRD-008 | cards are issued only while `card.virtual` is on (`apps/api/src/cards/service.ts:14`); agent purchases also need `card.agentic` (`apps/api/src/cards/jit.ts:31`) | REC-12 card authorisation |

- The processor's request is signature-checked by the card port (`apps/api/src/cards/jit.ts:82-92`).
- Checks, cheapest refusal first: card and token status, controls (channel, merchant category,
  country, agent mode), daily and monthly limits, purse balance, velocity, plan card cap
  (`apps/api/src/cards/jit.ts:132-194`).
- Velocity: the 11th approval on one card within a minute is declined (`apps/api/src/cards/jit.ts:29`, `:181-185`).
- Fail closed: any error, or no answer within 250 ms, is a decline (`apps/api/src/cards/jit.ts:33`, `:94-108`).
- A repeat of the same authorisation id answers the same and holds nothing more (`apps/api/src/cards/jit.ts:132`).
- Which purse pays (ADR-007, ADR-014 decision 10): the shekel purse first for a merchant in Israel, the
  authorisation's own currency elsewhere, then the other purse. One purse pays the whole amount. A purse in
  the other currency pays the amount at the club rate plus the member's plan markup; without a valid club
  rate that purse is skipped (`apps/api/src/cards/jit.ts:226-260`).

| Journal kind | Key | Dr | Cr | Currency |
|---|---|---|---|---|
| `auth_hold` | `jit:{authorisation id}` | member `wallet` | member `pending` | the authorisation currency |
| `auth_hold`, converted | `jit:{authorisation id}` | member `wallet` (paying purse), gross plus markup | `fx_position` gross, `fee_income` markup | the paying purse's currency |
| | | `fx_position` | member `pending` | the authorisation currency |

A converted hold records `fx_rate_id`, `fx_rate_version`, `fx_markup_bps`, the rate, `paidFrom` and
`markup` in its metadata.

Source: `apps/api/src/cards/jit.ts:34`, `:196-220`, `:262-283`.

Tests: TST-CRD-003 (`apps/api/src/cards/jit.test.ts:56-175`; `apps/api/src/cards/jit.bench.test.ts`),
TST-CRD-004 (`apps/api/src/cards/jit.test.ts:182-191`), TST-CRD-008 (`apps/api/src/cards/jit.test.ts:202-257`). Purse
choice: `apps/api/src/cards/jit.test.ts:289-366`.

Gap found: settlement is not in the code. SEQ-01 ends with "transaction.cleared, settle hold, journal". No
code handles the processor's clearing, moves the hold out of `pending`, or releases a hold that never
clears (no `auth_hold` consumer besides `apps/api/src/cards/jit.ts:198`, `:289`). This waits on the
processor choice (ADR-006); the engineering lead writes the card.

Decided (ADR-014, decision 9): built against the simulator before `card.virtual` turns on, with a 7-day release for holds that never clear. Card T-0410.

Gap found: SEQ-01 and ADR-007 say an ILS card authorisation draws on the ILS purse, converted at the club
rate if needed (`docs/adr/ADR-007.md:35-38`). The code held only in the purse of the authorisation's
own currency, with no conversion. The founder decides with the processor.

Decided (ADR-014, decision 10): the shekel purse pays first for a merchant in Israel; a short purse is covered by the other, converted at the club rate with the plan markup. Built in T-0409 (`apps/api/src/cards/jit.ts:226-260`).

## 13. Payout to an Israeli bank account

A member sends shekels from their ILS purse to a validated Israeli bank account.

| SEQ | REQ | Flag | Recording |
|---|---|---|---|
| SEQ-09 | REQ-PO-001, REQ-PO-002 | `payouts.nium` (`apps/api/src/payouts/service.ts:25`, `:128`) | REC-13 payout |

- ILS only (`apps/api/src/payouts/service.ts:144`). The payee is checked by us (Israeli IBAN checksum,
  name) and then by the provider (`apps/api/src/payouts/service.ts:136-137`, `:156-173`).
- Cooling off: a payee with no settled payout yet, and an amount above ₪2,000.00 (200,000 agorot),
  waits 24 hours with nothing moved (`apps/api/src/payouts/service.ts:28-30`, `:184-193`).
- Second approver: above ₪5,000.00 (500,000 agorot) the payout waits for a finance or org-admin
  approver who is not the requester (`apps/api/src/approvals/service.ts:11-12`, `:53`, `:76`, `:96`;
  `apps/api/src/payouts/service.ts:199-202`).
- Then the journal posts and the provider is asked, both under the same key
  (`apps/api/src/payouts/service.ts:204-221`). The worker resumes payouts whose cooling-off ended or
  whose approval landed, every minute (`apps/worker/src/payouts/payout-workflow.ts:1-8`).
- Provider webhooks settle or fail the payout once (`apps/api/src/payouts/service.ts:284-294`). A failure
  reverses the journal and pushes a notice to the payer (`apps/api/src/payouts/service.ts:251-257`).
- A provider outage keeps the money reserved on the journal for a retry with the same key; a payee the
  provider rejects reverses the journal and fails the payout (`apps/api/src/payouts/service.ts:222-233`).

| Journal kind | Key | Dr | Cr | Currency |
|---|---|---|---|---|
| `payout` | `{key}:settle` | member `wallet` | `partner_settlement` | ILS |
| `reversal` (on failure) | `{key}:settle:reversal` | `partner_settlement` | member `wallet` | ILS |

Source: `apps/api/src/payouts/service.ts:99`, `:208-218`, `:229`, `:253`.

Tests: TST-PO-001 (`apps/api/src/payouts/service.test.ts:75`; `apps/api/src/payouts/iban.test.ts:9-29`),
TST-PO-002 (`apps/api/src/payouts/service.test.ts:90`, `:129`, `:150`, `:175`;
`apps/worker/src/payouts/payout-workflow.test.ts:51`, `:88`). Example: a new payee at ₪3,000.00 is
scheduled 24 hours later (`apps/api/src/payouts/service.test.ts:90`).

Open: the second-approver line for a USD amount is above $1,250.00 (125,000 cents), set as ₪5,000 at
1:4 (`apps/api/src/approvals/service.ts:54`). Payouts are ILS only, so this applies to other kinds; the
finance lead confirms the dollar line.

## 14. Institution allowance run

An institution's finance user pays a scheduled allowance to every member on a date.

| SEQ | REQ | Flag | Recording |
|---|---|---|---|
| SEQ-07 | REQ-INS-003, REQ-INS-004 | none checked in the run (see Open) | REC-14 allowance run |

- Dry run first: the members and the total, with nothing moved (`apps/worker/src/allowance/workflow.ts:50-58`).
- One run per schedule and date, keyed `allowance:{scheduleId}:{date}` (`apps/worker/src/allowance/workflow.ts:47`).
- A total above ₪5,000.00 (500,000 agorot) waits for a second finance approver
  (`apps/worker/src/allowance/workflow.ts:45`, `:55`, `:64-67`; `apps/worker/src/allowance/activities.ts:48-53`).
- Payments fan out, at most 20 at once; a failed member is retried 3 times and then reported, and the
  others still get paid (`apps/worker/src/allowance/workflow.ts:43-44`, `:72-95`).

| Journal kind | Key | Dr | Cr | Currency |
|---|---|---|---|---|
| `allowance` | `allowance:{scheduleId}:{date}:{memberPartyId}` | `institution_master` | member `wallet` | schedule currency |

Source: `apps/worker/src/allowance/activities.ts:55-62`; key `apps/worker/src/allowance/workflow.ts:48`.

Tests: TST-INS-003 (`apps/worker/src/allowance/workflow.test.ts:51`, `:59`, `:85`), TST-INS-004
(`apps/worker/src/allowance/workflow.test.ts:73`; `apps/api/src/approvals/service.test.ts:35`, `:47`).

Gap found: the endpoint `POST /institutions/{id}/allowance-runs` has no handler and answers FEATURE_OFF
(`apps/api/src/routes.ts:61`; `apps/api/src/app.ts:215`, `:226-228`). The run exists only as the worker
body, and the worker has no running entry yet (`apps/worker/src/index.ts:1-2`). The engineering lead
schedules the card.

Decided (ADR-014, decision 11): card T-0607.

Gap found: allowance payments post the journal directly and create no `ops.transfer` row
(`apps/worker/src/allowance/activities.ts:60`), unlike every other member movement. The engineering lead
decides whether they should.

Decided (ADR-014, decision 11): each payment becomes an `ops.transfer` of kind `allowance`. Card T-0607.

Open: `institution_master` is one system account per currency for all institutions; the institution is
named only in the journal metadata (`apps/api/src/ledger/accounts.ts:55-57`;
`apps/worker/src/allowance/activities.ts:58-60`). How an institution's money reaches that account is not
in the code. The founder decides with the bank (ADR-006).

Gap found: the `institutions.money` flag gates collections (`apps/api/src/institutions/collections.ts:19`, `:104`)
but is not checked by the allowance run (`apps/worker/src/allowance/workflow.ts:61-100`). The engineering
lead decides whether the run must check it.

Decided (ADR-014, decision 11): the run checks the flag. Card T-0607.

## 15. Institution collections (fee payment)

A member pays a fee the institution has billed them, from their purse.

| SEQ | REQ | Flag | Recording |
|---|---|---|---|
| SEQ: not in Tab 3 §7 | REQ-INS-006 | `institutions.money` (`apps/api/src/institutions/collections.ts:19`, `:104`) | REC-15 collections |

- The purse must cover the fee (`apps/api/src/institutions/collections.ts:113-114`). Paying needs a
  step-up and an Idempotency-Key header (`apps/api/src/institutions/collections.ts:190-194`), but the
  money key is the fee item: `fee:{feeItemId}` (`apps/api/src/institutions/collections.ts:21`, `:156-160`).
- The receipt number is the journal's month and the last 12 hex digits of the journal id
  (`apps/api/src/institutions/collections.ts:76-79`).
- The institution's staff list a month and export it as CSV or XLSX; the totals equal the ledger
  (`apps/api/src/institutions/collections.ts:132-148`; `apps/api/src/institutions/export.ts:60-90`).

| Journal kind | Key | Dr | Cr | Currency |
|---|---|---|---|---|
| `fee` | `fee:{feeItemId}` | member `wallet` | `institution_master` | fee currency |

Source: `apps/api/src/institutions/collections.ts:115-127`.

Tests: TST-INS-006 (`apps/api/src/institutions/collections.test.ts:68`, `:109`, `:127`;
`apps/api/src/institutions/export.test.ts:49`, `:76`).

## 16. Add-on purchase (eSIM, insurance)

A member buys an add-on from the club catalogue with their purse.

| SEQ | REQ | Flag | Recording |
|---|---|---|---|
| SEQ-10 | REQ-MKT-001, REQ-ESIM-002, REQ-INSR-001 | none in the order path (see Open) | REC-16 add-on purchase |

- The order is keyed by the member's Idempotency-Key (`apps/api/src/addons/orders.ts:93-114`;
  `apps/api/src/app.ts:184-190`).
- Insurance is refused unless the member acknowledged the disclosures (`apps/api/src/addons/orders.ts:98`).
- A fulfilment failure after the charge reverses the charge and restores any data credit
  (`apps/api/src/addons/orders.ts:156-164`).

| Journal kind | Key | Postings | Currency |
|---|---|---|---|
| `addon` | `addon:{orderId}:charge` | Dr member `wallet` (price); Cr `addon_payable` (cost); Cr `fee_income` (price − cost; a debit when a member credit makes the club pay part of the cost) | price currency |
| `reversal` (on failure) | `addon:{orderId}:refund` | the charge postings negated | price currency |

Source: `apps/api/src/addons/orders.ts:1-7`, `:121-138`, `:161`. Example: a $25.00 eSIM costing $20.00
posts `addon_payable` $20.00 (2,000 cents) and `fee_income` $5.00 (500 cents)
(`apps/api/src/addons/orders.test.ts:75`).

Tests: TST-MKT-001 (`apps/api/src/addons/orders.test.ts:75`), TST-ESIM-002 (`apps/api/src/addons/orders.test.ts:89`),
the SEQ-10 compensation (`apps/api/src/addons/orders.test.ts:108`), REQ-INSR-001 (`apps/api/src/addons/orders.test.ts:125`).

Open: the order endpoint checks no flag (`apps/api/src/app.ts:184-190`), although `esim.airalo` and
`insurance.coverGenius` exist and are off (`config/flags.json:45`, `:59`). Orders also create no
`ops.transfer` row (`apps/api/src/addons/orders.ts:106`), so the monitoring job does not see them. The
engineering lead decides both.

## 17. Account closure refunds

A member closes their account. Whatever remains is refunded to where it came from.

| SEQ | REQ | Flag | Recording |
|---|---|---|---|
| SEQ: not in Tab 3 §7 | REQ-WAL-005 | none | REC-17 closure refunds |

- Closing is refused while holds are outstanding or a purse is overdrawn
  (`apps/api/src/wallet/closure.ts:59-60`). Auto-reload is switched off (`apps/api/src/wallet/closure.ts:61`).
- Refunds go against the member's settled loads, newest first, each up to what that load gave
  (`apps/api/src/wallet/closure.ts:63-73`, `:199-222`), through the funding provider
  (`apps/api/src/wallet/closure.ts:102`).
- The journal posts only when the provider confirms (`apps/api/src/wallet/closure.ts:112-135`). The
  account closes when every purse reads zero, and the audit chain records it
  (`apps/api/src/wallet/closure.ts:171-178`).
- Money with no load behind it (received by transfer) cannot be refunded here; the closure reports
  `NO_REFUND_SOURCE` (`apps/api/src/wallet/closure.ts:6-7`, `:181`).

| Journal kind | Key | Dr | Cr | Currency |
|---|---|---|---|---|
| `refund` | `closure:{partyId}:{loadTransferId}:settle` | member `wallet` | `partner_settlement` | purse currency |
| `refund`, converted load | same | member `wallet` (purse), `fee_income` (the markup share) | `fx_position` (the gross at the load's rate) | purse currency |
| | | `fx_position` | `partner_settlement` | instrument currency |

Source: `apps/api/src/wallet/closure.ts:46`, `:48`, `:120-135`, `:145-169`.

Tests: TST-WAL-005 (`apps/api/src/wallet/closure.test.ts:60`, `:96`, `:104`, `:121`, `:140`, `:158`).
Example: closing with $30.00 refunds it to the load's source and closes once the refund posts
(`apps/api/src/wallet/closure.test.ts:60`).

Gap found: refundable loads were matched by the load's own currency, so a load that converted into the
other purse (flow 3) left its credited balance with `NO_REFUND_SOURCE`.

Decided (ADR-014, decision 12): refund to source in the instrument currency, pro rata at the load's own
rate. Built in T-0521: loads are matched by the purse they credited
(`apps/api/src/wallet/closure.ts:210`), the source's share is computed in
`apps/api/src/wallet/closure.ts:254-260`, and the refund journal passes through `fx_position` in both
currencies (`apps/api/src/wallet/closure.ts:145-169`). The load's markup comes back with it pro rata:
fee income gives back its share, so a load refunded whole leaves `fx_position` and `fee_income` at zero
in both currencies. Tests: `apps/api/src/wallet/closure.test.ts:176-229`.

Open: REQ-WAL-005 says the balance is withdrawn or refunded. Money with no load behind it waits for the
member to request a payout (flow 13); the closure only reports it (`apps/api/src/wallet/closure.ts:6-7`).
Compliance decides whether staff must act on blocked closures, and by when.

## 18. Reversals and ledger corrections

Mistakes are fixed by a new reversing journal, never by editing one.

| SEQ | REQ | Flag | Recording |
|---|---|---|---|
| SEQ: not in Tab 3 §7 | REQ-LED-001, REQ-LED-002, REQ-LED-003 | none | REC-18 ledger reversals |

- `reverse()` posts the original postings negated, kind `reversal`, once per journal
  (`apps/api/src/ledger/post.ts:89-94`; `db/migrations/ledger/0001_init.sql:24`).
- The flows above use it for an ACH return (flow 2), a cancelled hold (flow 6), a failed payout
  (flow 13) and a failed add-on (flow 16).
- A ledger correction is an approval kind that always needs two people
  (`apps/api/src/approvals/service.ts:8`, `:52`). The nightly proof never fixes anything itself
  (`apps/worker/src/ledger/balance-proof.ts:4`).

Tests: TST-LED-001 to TST-LED-003 (`apps/api/src/ledger/post.test.ts:34-155`), reversal once
(`apps/api/src/ledger/post.test.ts:108`), and the nightly controls
(`apps/worker/src/ledger/balance-proof.test.ts:31`, `:40`; `apps/worker/src/recon/recon.test.ts:38-79`).

Open: no service, endpoint or console screen performs a manual correction. The `ledger_correction`
approval kind exists (`apps/api/src/approvals/service.ts:8`, `:52`) but nothing requests it, and the
route table has no correction path (`apps/api/src/routes.ts:15-89`). Finance and the engineering lead decide who
may raise a correction and how it is approved and recorded.
