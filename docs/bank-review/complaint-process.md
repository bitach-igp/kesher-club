# Complaint process

How a complaint is logged, the two service-level clocks that run on it, how it is escalated, and the
export the bank receives, as coded at commit `fb4c6de`.

Requirement: REQ-CMP-002, "Complaints MUST be logged with SLA timers (acknowledge 2 business days,
resolve 15) and be exportable for the bank", with the acceptance "Given an aged complaint, then it shows
red at day 13" (Tab 3 §3; `specs/requirements.md`). Test: TST-CMP-002
(`apps/api/src/admin/complaints.test.ts`, `apps/admin/src/compliance/sla.test.ts`).

## Logging a complaint

- Staff log a complaint on the member's behalf with a channel, a category and a summary
  (`apps/api/src/admin/complaints.ts:108-128`; `apps/api/src/admin/handlers.ts:102-111`).
- Channels: app, email, phone, bank, regulator (`apps/api/src/admin/complaints.ts:12`).
- The complaint may be back-dated to when it reached us (a phone call or letter logged later), never
  into the future (`apps/api/src/admin/complaints.ts:40-41`, `:115-116`). Both clocks start at that
  time (`db/migrations/ledger/0006_complaints.sql:12`).
- The summary is the member's own text: stored and shown as text, never acted on
  (`apps/api/src/admin/complaints.ts:1-4`, `:21-22`).
- Opening writes an audit entry; the member's text stays out of the audit chain
  (`apps/api/src/admin/complaints.ts:124-125`).

Proved by `apps/api/src/admin/complaints.test.ts:38`, `:51`, `:60`.

## The two clocks

| Clock | Deadline | Counted in | Starts | Stops | Source |
|---|---|---|---|---|---|
| Acknowledge | 2 business days | business days | `openedAt` | `acknowledgedAt` | `apps/admin/src/compliance/sla.ts:6`, `:67`, `:69-70` |
| Resolve | 15 business days | business days | `openedAt` | `resolvedAt` | `apps/admin/src/compliance/sla.ts:7`, `:68`, `:72-76` |

- A business day is Monday to Friday, minus holidays supplied as a calendar
  (`apps/admin/src/compliance/sla.ts:3`, `:19-22`). Dates are taken in UTC (`apps/admin/src/compliance/sla.ts:20`, `:28-29`).
- A deadline is the end of the Nth business day after the day the complaint opened; the opening day
  itself does not count (`apps/admin/src/compliance/sla.ts:24-47`).
- The acknowledge clock is met when the acknowledgement time is on or before its deadline, and breached
  when it is later, or when there is no acknowledgement and the deadline has passed
  (`apps/admin/src/compliance/sla.ts:69-70`).

The resolve clock shows a colour by business days open (`apps/admin/src/compliance/sla.ts:8-9`, `:71-76`):

| Business days open | Colour |
|---|---|
| 0 to 9 | green |
| 10 to 12 | amber |
| 13 to 15 | red |
| more than 15 | breached |
| resolved or withdrawn | closed |

The queue lists breached and red complaints first, then oldest first within a colour
(`apps/admin/src/compliance/sla.ts:80-85`).

Acknowledging and resolving stamp the staff member's SSO subject and the API's clock, so the console and
the export read the same times (`apps/api/src/admin/complaints.ts:1-4`, `:130-160`). Resolving an open
complaint acknowledges it in the same step with the same stamps
(`apps/api/src/admin/complaints.ts:145-160`). A complaint only moves forward: a second acknowledge or a
second resolve is refused (`apps/api/src/admin/complaints.ts:133`, `:149`). Each step writes an audit
entry (`apps/api/src/admin/complaints.ts:140`, `:157`).

Proved by TST-CMP-002: `apps/admin/src/compliance/sla.test.ts:15` (business days, weekends and
holidays), `:23` (2 and 15 days; amber at 10, red at 13, breached after 15), `:35` (queue order), `:54`
(stamps); `apps/api/src/admin/complaints.test.ts:68`, `:86`.

## Escalation

- A complaint carries one flag, `escalatedToBank`, set when it is logged
  (`apps/api/src/admin/complaints.ts:31`, `:39`, `:122`; `db/migrations/ledger/0006_complaints.sql:19`).
  It appears in the export.
- The resolve clock turns amber at day 10 and red at day 13 so a breach is visible before day 16
  (`apps/admin/src/compliance/sla.ts:1-2`).
- The first staff member to acknowledge or resolve becomes the owner
  (`apps/api/src/admin/complaints.ts:136`, `:152`).

Open: `escalatedToBank` can be set only when the complaint is logged; no endpoint changes it later
(`apps/api/src/admin/handlers.ts:97-121`). Nothing escalates automatically when a clock turns red or is
breached (`apps/admin/src/compliance/sla.ts:62-78` only computes the colour). Compliance and the bank
decide when a complaint must go to the bank, and how that is recorded.

Open: the status `withdrawn` exists in the table (`db/migrations/ledger/0006_complaints.sql:11`) but no
endpoint sets it (`apps/api/src/admin/handlers.ts:97-121`). Compliance decides whether staff need it.

Open: the code has no in-app path for a member to file a complaint; only staff log them
(`apps/api/src/admin/handlers.ts:102-111`), although the table expects `logged_by = 'member'` when the
app files one (`db/migrations/ledger/0006_complaints.sql:13`). Product decides when the app gets one.

## The bank export

The CSV export was built with the console's complaint screens (T-0904, `apps/admin/README.md:20`); the
complaint table and the API endpoints it reads came with T-0908 (`specs/tasks/T-0908.md:1-4`).

The admin console serves the export at `/compliance/complaints/export`
(`apps/admin/app/compliance/complaints/export/route.ts:1-11`). It returns every complaint, open ones
first by age then closed ones newest first, as a CSV file named `complaints-YYYY-MM-DD.csv`
(`apps/api/src/admin/complaints.ts:97-101`; `apps/admin/app/compliance/complaints/export/route.ts:9-10`).

Columns, in order (`apps/admin/src/compliance/sla.ts:94`, `:97-104`):

| Column | Meaning |
|---|---|
| `id` | complaint id |
| `party_id` | member id |
| `channel` | app, email, phone, bank or regulator |
| `category` | staff-chosen category |
| `summary` | the member's text, escaped as data |
| `opened_at` | when the complaint reached us; both clocks start here |
| `acknowledged_at` | when it was acknowledged |
| `ack_due` | acknowledge deadline (2 business days) |
| `ack_met` | true, false, or empty while not yet acknowledged |
| `resolved_at` | when it was resolved |
| `resolve_due` | resolve deadline (15 business days) |
| `status` | open, acknowledged, resolved or withdrawn |
| `business_days_open` | business days from opening to resolution, or to now |
| `sla_colour` | green, amber, red, breached or closed |
| `owner` | staff subject who first handled it |
| `escalated_to_bank` | true or false |

A cell that starts with `=`, `+`, `-`, `@`, a tab or a carriage return is prefixed with a quote, so a
spreadsheet never runs member text as a formula (`apps/admin/src/compliance/sla.ts:87-92`). Proved by
`apps/admin/src/compliance/sla.test.ts:45` and `apps/api/src/admin/complaints.test.ts:95`.

Who can run it: any staff member signed in to the admin console. The console is reachable only from
the VPN, with SSO and a phishing-resistant authenticator (`apps/admin/src/auth/guard.ts:25-28`;
`apps/admin/src/auth/session.ts:7-8`). The export route checks that a signed-in staff identity is
present and nothing more (`apps/admin/app/compliance/complaints/export/route.ts:7`;
`apps/admin/src/ui/actor.ts:6-11`). The console reads complaints from the API with a staff token
(`apps/admin/src/data/http.ts:121-123`).

Open: the route's header comment says each download is audited
(`apps/admin/app/compliance/complaints/export/route.ts:1`), but the route writes no audit entry
(`apps/admin/app/compliance/complaints/export/route.ts:6-11`). The engineering lead adds it or corrects
the comment; compliance decides whether downloads must be audited.

Open: the export passes no holiday calendar (`apps/admin/app/compliance/complaints/export/route.ts:9`),
and no calendar is configured anywhere in the console, so holidays count as business days today. The
bank supplies the holiday calendar to use.

Open: business days are Monday to Friday in UTC (`apps/admin/src/compliance/sla.ts:19-22`). The Israeli
working week is Sunday to Thursday. Compliance and the bank decide which week, and which time zone, the
clocks use.

Open: any console user can download the export; there is no role check
(`apps/admin/app/compliance/complaints/export/route.ts:7`). Compliance decides whether it is limited to
a compliance role.
