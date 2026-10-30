# Bank-review package

This package is for the partner bank's compliance team. It describes how Kesher Club moves money,
how it monitors transactions, how it handles complaints, and which legal documents and disclosures
members see. Every statement is tied to the code or test that makes it true, so a reviewer can check
it rather than take it on trust.

State described: commit `fb4c6de` on branch `claude/practical-babbage-80xevv`, 18 October 2026. Updated since:
money-flows §13 (institution withdrawals, T-0927) and the recordings (T-0920 to T-0923, T-0927), 30 October 2026.

## Read this first

- **Nothing here is live.** Every money feature sits behind a feature flag that is off in production
  by default, each waiting on a named condition such as "Program agreement + bank approval" for the
  wallet (`config/flags.json:73-77`) or "Bank approves book transfers" for member transfers
  (`config/flags.json:122-126`).
- **Every outside provider is a simulator today.** Payments, card processing, FX and payouts run
  against stateful simulators behind provider interfaces; the real vendor adapters come one per
  contract (`README.md:6-8`). The tests cited here run against those simulators and an in-memory
  Postgres.
- **The workflows run in the API and the worker, not yet on a workflow engine.** Each money flow is a
  deterministic function meant to be hosted by one (for example `apps/api/src/wallet/loads.ts:18-20`); the
  API and the worker start as services (`apps/api/src/index.ts:1-3`; `apps/worker/src/index.ts:1-3`) and run
  them directly, and the recordings drive that running product on the simulators.
- **Where the code leaves a question unanswered, the document says so.** Such lines start with
  `Open:` and say who decides. They are questions, not findings of fault.

## The documents

| Document | What it covers |
|---|---|
| [money-flows.md](money-flows.md) | All 18 money flows: plain description, sequence diagram (SEQ), requirements (REQ), ledger postings, idempotency keys, tests and the screen recording of each |
| [monitoring-rules.md](monitoring-rules.md) | The four transaction monitoring rules with their exact thresholds, the flag that enables them, and the alert disposition path |
| [complaint-process.md](complaint-process.md) | The acknowledge and resolve clocks, escalation, and the CSV export the bank receives |
| [disclosures.md](disclosures.md) | The legal document types, how consent is recorded and re-asked, and the disclosures shown before payment |
| [institution-kyb.md](institution-kyb.md) | What Kesher checks about an institution (a school) before its deposits, allowances, credit or payouts run, which capability each KYB outcome unlocks, and the questions the bank is asked to answer |

Suggested order: this page, then money-flows.md ("How every flow is booked" first), then the other
four in any order.

## How evidence is cited

- `path/to/file.ts:LINE` (or `:FROM-TO`) points at the line of code that makes a statement true, at
  the commit above. `:12`, `:40` after a path means more lines in the same file.
- `TST-XXX-NNN` is the test for requirement `REQ-XXX-NNN`; the test file is named next to it. Tests
  print their TST id in the test name, so `pnpm test` output can be matched to this package.
- `REQ-XXX-NNN` requirement ids come from the live specification, Tab 3 §2-3 ("Build-ready
  specification"), mirrored in `specs/requirements.md`.
- `SEQ-NN` sequence ids come from the live specification, Tab 3 §7 ("Key flows"). Where a flow has no
  diagram there, the document says "SEQ: not in Tab 3 §7".
- `REC-NN` is a product walkthrough of the flow, a video asset of the GitHub Release
  `bank-review-recordings-2026-10-30` (see Recordings below); the run's log is in `handoff/done/recordings/`.
- Money in code is in minor units: cents for USD, agorot for ILS. The documents show both, for example
  ₪500.00 (50,000 agorot).

The live specification was read for this package (Tab 3 §2-3 and §7, document revision 22). All SEQ
ids come from Tab 3 §7, which lists SEQ-01 to SEQ-10; none were taken from code comments alone.

## Recordings

Each REC is a product walkthrough recorded by the browser itself from the running product on the simulators
(`apps/demo/src/record/`; how to run them is in `docs/setup/demo.md`). One page holds the panes side by side: the
member app or the institution console, the simulator panel (the vendor's side and the shared clock), and the admin
console. Every recording asserts that the amounts on screen and in the console equal the flow's worked example in
money-flows.md, in minor units, so a recording cannot pass while showing a wrong number. A step with no screen is
shown as a caption naming the API call ("API walkthrough"), never as a screen.

The videos are the assets of the GitHub Release `bank-review-recordings-2026-10-30`, published from the team's
workstation at the commit it recorded (`handoff/desktop/T-0923-flow-walkthroughs.md`); they are not in git. The run's
log, with every recording's assertions, is kept in `handoff/done/recordings/`, next to the earlier test-run logs
(T-0912) that remain the evidence of the tests themselves.

| Recording | Flow | Product walkthrough (panes) | API walkthrough (steps with no screen) |
|---|---|---|---|
| [REC-01](https://github.com/bitach-igp/kesher-club/releases/download/bank-review-recordings-2026-10-30/REC-01-load-by-card.webm) | Load by card | member app (Dana adds $100.00 by card); Customer 360 | — |
| [REC-02](https://github.com/bitach-igp/kesher-club/releases/download/bank-review-recordings-2026-10-30/REC-02-ach-hold-release.webm) | ACH load hold and release | member app; Customer 360 | the release after 3 business days is read through the staff API, after the clock moves |
| [REC-03](https://github.com/bitach-igp/kesher-club/releases/download/bank-review-recordings-2026-10-30/REC-03-load-other-purse.webm) | Load into the other purse | member app; Customer 360 | — |
| [REC-04](https://github.com/bitach-igp/kesher-club/releases/download/bank-review-recordings-2026-10-30/REC-04-auto-reload.webm) | Auto-reload | member app; Customer 360 | the trigger runs as the job would, from the panel |
| [REC-05](https://github.com/bitach-igp/kesher-club/releases/download/bank-review-recordings-2026-10-30/REC-05-p2p-send.webm) | P2P send | member app (sender, then recipient); Customer 360 | — |
| [REC-06](https://github.com/bitach-igp/kesher-club/releases/download/bank-review-recordings-2026-10-30/REC-06-p2p-new-pair-hold.webm) | P2P new-pair hold | member app; Customer 360 | the release runs as the job would, from the panel |
| [REC-07](https://github.com/bitach-igp/kesher-club/releases/download/bank-review-recordings-2026-10-30/REC-07-p2p-cross-currency.webm) | P2P cross-currency send | member app; Customer 360 | — |
| [REC-08](https://github.com/bitach-igp/kesher-club/releases/download/bank-review-recordings-2026-10-30/REC-08-requests-splits.webm) | Requests and splits | member app; Customer 360 | — |
| [REC-09](https://github.com/bitach-igp/kesher-club/releases/download/bank-review-recordings-2026-10-30/REC-09-assistant-send.webm) | Assistant-proposed send | member app (approval with passkey); Customer 360 | the assistant's proposal is an MCP tool call |
| [REC-10](https://github.com/bitach-igp/kesher-club/releases/download/bank-review-recordings-2026-10-30/REC-10-fx-conversion.webm) | FX conversion | member app (M18); Customer 360 | — |
| [REC-11](https://github.com/bitach-igp/kesher-club/releases/download/bank-review-recordings-2026-10-30/REC-11-club-rates.webm) | Club rates | member app (the quote that follows the rate) | the manual rate is proposed and approved through the staff API by two finance members |
| [REC-12](https://github.com/bitach-igp/kesher-club/releases/download/bank-review-recordings-2026-10-30/REC-12-card-authorisation.webm) | Card authorisation | member app; Customer 360 | the tap at the till comes from the vendor's side (the panel) |
| [REC-13](https://github.com/bitach-igp/kesher-club/releases/download/bank-review-recordings-2026-10-30/REC-13-institution-withdrawal.webm) | Institution withdrawal | institution console (I09, Rivka then Shimon); admin console | the deposit is recorded and approved through the staff API; reads after the clock moves use the staff API |
| [REC-14](https://github.com/bitach-igp/kesher-club/releases/download/bank-review-recordings-2026-10-30/REC-14-allowance-run.webm) | Allowance run | institution console (I07, Rivka then Shimon); member app (three students) | — |
| [REC-15](https://github.com/bitach-igp/kesher-club/releases/download/bank-review-recordings-2026-10-30/REC-15-collections.webm) | Collections | institution console (I08); member app | Noa pays by API: Tab 2 has no member fee screen |
| [REC-16](https://github.com/bitach-igp/kesher-club/releases/download/bank-review-recordings-2026-10-30/REC-16-addon-purchase.webm) | Add-on purchase | member app (M26, eSIM checkout); Customer 360 | — |
| [REC-17](https://github.com/bitach-igp/kesher-club/releases/download/bank-review-recordings-2026-10-30/REC-17-closure-refunds.webm) | Closure refunds | member app (M34) | the result is read through the staff API |
| [REC-18](https://github.com/bitach-igp/kesher-club/releases/download/bank-review-recordings-2026-10-30/REC-18-ledger-reversals.webm) | Ledger reversals | member app (Avi's ACH load); Customer 360 | the bank's return comes from the vendor's side (the panel); the balance proof runs as the nightly job does |

## Open items

Each document ends its sections with its `Open:` lines. ADR-014 (2026-10-19) decided the thirteen
money-flow items that were conflicts between the spec and the code or waited on engineering; those now
read `Gap found:` followed by `Decided (ADR-014, decision N)` and the card that carries the work. What is
still open:

| Document | Open items |
|---|---|
| money-flows.md | 6 |
| monitoring-rules.md | 6 |
| complaint-process.md | 7 |
| disclosures.md | 9 |

The ones a bank reviewer is most likely to ask about first:

- Card settlement (clearing) is not in the code; only the authorisation hold is (money-flows.md, flow 12).
- Member transfers post an internal journal and call no processor, although the specification calls
  them a partner book transfer (money-flows.md, flow 5).
- Monitoring thresholds await compliance sign-off, and "escalated" triggers nothing beyond the record
  (monitoring-rules.md).
- Complaint clocks count Monday to Friday in UTC with no holiday calendar
  (complaint-process.md).
- No legal document version is published or shown yet (disclosures.md).
