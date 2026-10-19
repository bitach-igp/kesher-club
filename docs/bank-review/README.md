# Bank-review package

This package is for the partner bank's compliance team. It describes how Kesher Club moves money,
how it monitors transactions, how it handles complaints, and which legal documents and disclosures
members see. Every statement is tied to the code or test that makes it true, so a reviewer can check
it rather than take it on trust.

State described: commit `fb4c6de` on branch `claude/practical-babbage-80xevv`, 18 October 2026.

## Read this first

- **Nothing here is live.** Every money feature sits behind a feature flag that is off in production
  by default, each waiting on a named condition such as "Program agreement + bank approval" for the
  wallet (`config/flags.json:73-77`) or "Bank approves book transfers" for member transfers
  (`config/flags.json:122-126`).
- **Every outside provider is a simulator today.** Payments, card processing, FX and payouts run
  against stateful simulators behind provider interfaces; the real vendor adapters come one per
  contract (`README.md:6-8`). The tests cited here run against those simulators and an in-memory
  Postgres.
- **The workflows run under tests, not yet as a service.** Each money flow is a deterministic function
  meant to be hosted by a workflow engine (for example `apps/api/src/wallet/loads.ts:17-19`), but the
  API and worker entry points do not start anything yet (`apps/api/src/index.ts:1-2`;
  `apps/worker/src/index.ts:1-2`).
- **Where the code leaves a question unanswered, the document says so.** Such lines start with
  `Open:` and say who decides. They are questions, not findings of fault.

## The documents

| Document | What it covers |
|---|---|
| [money-flows.md](money-flows.md) | All 18 money flows: plain description, sequence diagram (SEQ), requirements (REQ), ledger postings, idempotency keys, tests and the screen recording of each |
| [monitoring-rules.md](monitoring-rules.md) | The four transaction monitoring rules with their exact thresholds, the flag that enables them, and the alert disposition path |
| [complaint-process.md](complaint-process.md) | The acknowledge and resolve clocks, escalation, and the CSV export the bank receives |
| [disclosures.md](disclosures.md) | The legal document types, how consent is recorded and re-asked, and the disclosures shown before payment |

Suggested order: this page, then money-flows.md ("How every flow is booked" first), then the other
three in any order.

## How evidence is cited

- `path/to/file.ts:LINE` (or `:FROM-TO`) points at the line of code that makes a statement true, at
  the commit above. `:12`, `:40` after a path means more lines in the same file.
- `TST-XXX-NNN` is the test for requirement `REQ-XXX-NNN`; the test file is named next to it. Tests
  print their TST id in the test name, so `pnpm test` output can be matched to this package.
- `REQ-XXX-NNN` requirement ids come from the live specification, Tab 3 §2-3 ("Build-ready
  specification"), mirrored in `specs/requirements.md`.
- `SEQ-NN` sequence ids come from the live specification, Tab 3 §7 ("Key flows"). Where a flow has no
  diagram there, the document says "SEQ: not in Tab 3 §7".
- `REC-NN` is a screen recording requested from the team's Windows workstation in
  `handoff/desktop/T-0912-flow-recordings.md`. When it has run, the files are in
  `handoff/done/recordings/` with the same names.
- Money in code is in minor units: cents for USD, agorot for ILS. The documents show both, for example
  ₪500.00 (50,000 agorot).

The live specification was read for this package (Tab 3 §2-3 and §7, document revision 22). All SEQ
ids come from Tab 3 §7, which lists SEQ-01 to SEQ-10; none were taken from code comments alone.

## Recordings

Each REC is a recording of the flow's own tests running against the simulators, with a text log of
the run. A recording of the member app was not possible: the mobile app has no Expo build yet
(`apps/mobile/README.md:32-35`), several flows have no screen at all, and the API does not start as a
server (`apps/api/src/index.ts:1-2`). The request says, step by step, which flows have no screen.

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
- An assistant-proposed transfer, once approved, is never sent (money-flows.md, flow 9).
- Monitoring thresholds await compliance sign-off, and "escalated" triggers nothing beyond the record
  (monitoring-rules.md).
- Complaint clocks count Monday to Friday in UTC with no holiday calendar
  (complaint-process.md).
- No legal document version is published or shown yet (disclosures.md).
