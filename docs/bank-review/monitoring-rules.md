# Transaction monitoring rules

What the monitoring job looks for, the exact thresholds as coded at commit `fb4c6de`, the flag that turns
it on, and what happens to an alert from the moment it opens until it is closed.

Requirement: REQ-CMP-001, "The monitoring engine MUST raise alerts for velocity, structuring and P2P
fan-in/out rules, and queue them with dispositions" (Tab 3 §3; `specs/requirements.md`). Test:
TST-CMP-001 (`apps/worker/src/monitoring/rules.test.ts`, `apps/worker/src/monitoring/job.test.ts`).

**Thresholds await compliance sign-off.** The flag that turns the rules on is off in production by
default, and its turn-on condition is "Compliance signs off the thresholds; console queue staffed"
(`config/flags.json:185-189`). The code says compliance tunes the thresholds in one place
(`apps/worker/src/monitoring/rules.ts:58-64`).

## The flag

| Flag | Default in production | Turn-on condition | Effect when off |
|---|---|---|---|
| `monitoring.rules` | off | Compliance signs off the thresholds; console queue staffed | the job reads and writes nothing |

Sources: `config/flags.json:185-189`; `apps/worker/src/monitoring/job.ts:15`, `:56`. Proved by
`apps/worker/src/monitoring/job.test.ts:113`.

## What the job reads

- Every P2P send and payout created in the last 24 hours, whatever became of it: a declined or failed
  send still counts toward a pattern (`apps/worker/src/monitoring/job.ts:64-73`).
- The look-back is the longest rule window, 24 hours (`apps/worker/src/monitoring/job.ts:54`;
  `apps/worker/src/monitoring/rules.ts:67`).
- Patterns are counted per party and per currency; shekel and dollar movements never add together
  (`apps/worker/src/monitoring/rules.ts:101-113`).
- A finding holds ids, counts, amounts and times. A member's note never reaches a rule or a case
  (`apps/worker/src/monitoring/rules.ts:1-6`; `apps/worker/src/monitoring/rules.test.ts:123`).

Loads, FX conversions, allowances, fees and add-on purchases are not read by the job
(`apps/worker/src/monitoring/job.ts:68`).

## The rules

All windows start at the first movement of a pattern and include movements up to exactly the window
length after it (`apps/worker/src/monitoring/rules.ts:85-99`). After a hit the scan moves past the
window, so one burst gives one finding (`apps/worker/src/monitoring/rules.ts:80-84`).

| Rule | What it detects | Threshold and window, as coded | Movements counted | Case kind, severity |
|---|---|---|---|---|
| Structuring | Many sends each kept just under the P2P hold line (₪500 / $150, see money-flows flow 6) | 10 or more sends within 1 hour, each from 80% of the line up to, not including, the line: ₪400.00 to ₪499.99 (40,000 to 49,999 agorot), or $120.00 to $149.99 (12,000 to 14,999 cents) | P2P sends by one sender | `structuring`, high |
| Velocity | Too many movements, or too much money, out of one purse | 25 or more outgoing movements within 24 hours, or a total of ₪20,000.00 (2,000,000 agorot) or $6,000.00 (600,000 cents) or more | P2P sends and payouts by one member | `velocity`, medium; high when both limits are passed |
| Fan-in | One member paid by many others | 10 or more different senders within 24 hours | P2P sends received by one member | `velocity` with rule `fan_in`, medium |
| Fan-out | One member paying many others | 10 or more different recipients within 24 hours | P2P sends by one member | `velocity` with rule `fan_out`, medium |

Sources:
- Thresholds: `apps/worker/src/monitoring/rules.ts:59-64`; the hold line comes from
  `apps/api/src/p2p/holds.ts:14`; one hour and one day are `packages/ports/src/base.ts:58-59`.
- Structuring: `apps/worker/src/monitoring/rules.ts:134-159` (the "just under" test is line 139).
- Velocity: `apps/worker/src/monitoring/rules.ts:161-186`; outgoing means P2P and payout
  (`apps/worker/src/monitoring/rules.ts:69-70`); severity line 180.
- Fan-in: `apps/worker/src/monitoring/rules.ts:188-207`. Fan-out: `apps/worker/src/monitoring/rules.ts:209-228`.

Proved by TST-CMP-001:
- Structuring: ten sends of ₪490 within an hour are one finding; nine are none; ten spread over more
  than an hour are none (`apps/worker/src/monitoring/rules.test.ts:22`); only sends just under the line
  count (`:33`); a second burst after the window is a second finding (`:43`).
- Velocity: 25 movements or ₪20,000 out in a day; both at once is high (`apps/worker/src/monitoring/rules.test.ts:58`);
  loads in, allowances and the receiving side do not count (`:72`).
- Fan-in and fan-out: ten different counterparties in a day; nine are none
  (`apps/worker/src/monitoring/rules.test.ts:82`, `:94`).
- End to end against the database: `apps/worker/src/monitoring/job.test.ts:46`, `:62`, `:83`.

The spec's acceptance for REQ-CMP-001, "Given 10 sends of ₪490 in an hour, then a structuring alert",
is the test at `apps/worker/src/monitoring/job.test.ts:46`.

## No duplicate alerts

The job opens at most one case per pattern (`apps/worker/src/monitoring/job.ts:75-105`):

1. Each finding has a key built from the rule, the party, the currency and the first transfer of the
   pattern (`apps/worker/src/monitoring/rules.ts:130`). A re-run over the same data opens nothing new
   (`apps/worker/src/monitoring/job.ts:99-104`).
2. If an existing case for the same party and rule already lists any of the finding's transfers, the
   finding is a duplicate (`apps/worker/src/monitoring/job.ts:76-80`).
3. While a case for the same party and rule is undecided (no disposition, or `in_review`), a new
   finding is suppressed. Once compliance records `cleared` or `escalated`, the next pattern opens a new
   case (`apps/worker/src/monitoring/job.ts:81-86`; `apps/worker/src/monitoring/job.test.ts:62`).

## Disposition path

| Step | Where | Who | How | Source |
|---|---|---|---|---|
| 1. Alert opens | `ops.case`, status `open`, with the rule, party, currency, counts, total, window, transfer ids and a summary | the monitoring job | one case per finding | `apps/worker/src/monitoring/job.ts:87-103` |
| 2. Queue | admin console, compliance alert queue (`/admin/alerts`) | any signed-in staff member | undecided alerts first, worst severity first, then oldest | `apps/api/src/admin/alerts.ts:90-101`; `apps/admin/src/compliance/alerts.ts:6-8` |
| 3. Decision | `POST /admin/alerts/{id}/decisions` | any signed-in staff member | one of `in_review`, `cleared`, `escalated`, with a note of 1 to 500 characters | `apps/api/src/admin/alerts.ts:13`, `:109-113`; `apps/api/src/admin/handlers.ts:128-133` |
| 4. Record | the case row and the audit chain | the API | stamps the staff subject, time and note; `cleared` sets the case `resolved`, the others `investigating`; writes an audit entry `alert.{disposition}` | `apps/api/src/admin/alerts.ts:117-130` |
| 5. Close | the case | staff | `cleared` and `escalated` are final; `in_review` can be decided again | `apps/api/src/admin/alerts.ts:108`, `:116`, `:124` |

Staff reach the console only over the VPN, signed in with SSO and a phishing-resistant authenticator
(`apps/admin/src/auth/guard.ts:25-28`; `apps/admin/src/auth/session.ts:7-8`). The API accepts admin
calls only with a staff token (`apps/api/src/admin/staff-token.ts:72-78`).

Proved by `apps/api/src/admin/alerts.test.ts:45` (queue order), `:61` (in_review then cleared, audited),
`:81` (escalated is final), `:92` (validation) and `apps/admin/src/compliance/sla.test.ts:64`.

Fan-in and fan-out cases appear in the queue as `velocity` with the rule named in the payload
(`apps/worker/src/monitoring/rules.ts:13-14`). The same queue also lists `sanctions_hit`,
`kyc_manual_review` and `recon_break` cases (`apps/api/src/admin/alerts.ts:11`); reconciliation breaks
are opened by the nightly reconciliation job (`apps/worker/src/recon/recon.ts:1-4`).

## Open items

Open: the thresholds above are v1 and await compliance sign-off before `monitoring.rules` is turned on
(`config/flags.json:189`). The compliance officer decides the values.

Open: any staff member with a console session can decide an alert; the API checks for a staff token but
no compliance role (`apps/api/src/admin/handlers.ts:128-133`; `apps/api/src/admin/staff-token.ts:57`,
`:76`). Compliance decides whether decisions are limited to a compliance role.

Open: `escalated` only records the decision (`apps/api/src/admin/alerts.ts:117-125`). Nothing in the
code files a suspicious activity report, notifies the bank or freezes the member. Compliance and the
bank decide what an escalation must trigger and who does it.

Open: how often the job runs is not set in code. The worker has no running entry yet
(`apps/worker/src/index.ts:1-2`) and the job defines no cycle (`apps/worker/src/monitoring/job.ts:43-62`).
The engineering lead sets the schedule with compliance.

Open: the queue shows how long an alert has waited (`apps/admin/src/compliance/alerts.ts:18-19`) but the
code sets no deadline for a decision. Compliance decides whether alerts get a review SLA.

Open: loads, FX conversions and add-on purchases are outside every rule
(`apps/worker/src/monitoring/job.ts:68`; `apps/worker/src/monitoring/rules.ts:69-70`). Compliance decides
whether, for example, rapid loads followed by payouts need a rule.
