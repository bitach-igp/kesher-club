# Runbooks

Security evidence lives beside these: [pentest scope and rules](../security/pentest/README.md) and the
[SOC 2 evidence index](../security/soc2/README.md), both indexed in [../security/README.md](../security/README.md).

One file per alert that pages, in the format of Tab 3 §11 of the live spec. The alert's definition
(infra/terraform, the observability stack) links the runbook by its RUN number; nobody should need
to search for one at 03:00.

| RUN | Trigger (alert) | First five minutes | Resolution path | Member message |
|---|---|---|---|---|
| [RUN-01 Provider outage](RUN-01-provider-outage.md) | Contract-check or error-rate alert on a port | Confirm on the provider status page; flip the capability to `degraded` with banner copy; pause dependent workflows | Retry queue drains on recovery; reconcile; post-incident note | "Card top-ups are delayed. Your money is safe." |
| [RUN-02 JIT latency or decline spike](RUN-02-jit-latency.md) | JIT p99 over 300 ms for 5 minutes, or error rate over 1% | Check replica lag and DB CPU; scale the jit service; confirm the processor stand-in is active | Root cause; load-test the fix | Push to affected members only |
| [RUN-03 Reconciliation break](RUN-03-reconciliation-break.md) | Break over $50 or aged over 24 h | Freeze the payout queue for affected accounts; pull the processor record | Correcting journal (two-person) or provider dispute | None unless a member's balance changed |
| [RUN-04 Card compromise](RUN-04-card-compromise.md) | Fraud alert or member report | Freeze card and tokens; block MCC or country if a pattern is found | Reissue; dispute per Reg E timelines | "We froze your card to protect you…" |
| [RUN-05 Webhook backlog](RUN-05-webhook-backlog.md) | Lag over 5 minutes | Check ingress 5xx and worker health; scale workers | Replay from `ops.inbound_event`; verify dedupe | — |
| [RUN-06 Agent abuse](RUN-06-agent-abuse.md) | MCP rate-limit storm or intent-reject spike | Revoke the client's grants; flip `mcp.write.enabled` off if widespread | Block the client ID metadata URL; review the audit | Email affected users listing the grants revoked |
| [RUN-07 Data incident](RUN-07-data-incident.md) | Security alert, secrets exposure | Rotate the affected secrets; isolate; preserve logs | Counsel within 24 h; regulators and the bank per contract; Israeli PPA notice rules | Template approved by counsel |
| [RUN-08 Restore from backup](RUN-08-restore-from-backup.md) | DR declared | Stop writes (maintenance flag); restore PITR to a new instance | Ledger first, then reconcile, then re-enable flags in order | Status page |

## Alerts that page

From Tab 3 §9. Each names its runbook.

| Alert | Threshold | RUN |
|---|---|---|
| JIT latency | p99 over 300 ms for 5 minutes | RUN-02 |
| JIT errors | error rate over 1% | RUN-02 |
| Webhook lag | over 5 minutes | RUN-05 |
| Reconciliation break | over $50, or aged over 24 h | RUN-03 |
| Workflow failure | any failure in a money namespace | RUN-01 (provider) or RUN-03 (books) |
| Temporal backlog | over 1,000 tasks | RUN-05 |
| RDS CPU | over 80% for 15 minutes | RUN-02 |
| Certificate expiry | within 14 days | RUN-07 (rotate before it bites) |
| Port contract check | nightly suite red against the sandbox or live adapter | RUN-01 |

## On-call

- One primary and one secondary, weekly, handed over on Monday at 10:00 Asia/Jerusalem with a note in
  `#incidents` naming open cases and anything degraded.
- Severities: SEV1 money wrong or cards down for many members; SEV2 one capability degraded or a
  member's balance wrong; SEV3 everything else that pages.
- The first message in `#incidents` names the RUN, the scope (market, members, provider) and who is
  driving. The bank contact is told for any SEV1 or SEV2 that touches funds or cards.
- Post-incident note within 2 business days, linked from the case in the console.
- Dry run: each runbook is walked through once a quarter against staging; the `Last tested` line in
  the file records the date.

## Rules that hold in every runbook

- Stabilise with reversible steps only: freeze, flip a flag to degraded, pause a workflow.
- Money corrections are reversing journals with two-person approval (`ledger_correction` in the
  approvals service). Nobody edits `ledger.*` rows; the role cannot.
- Re-enable flags in the order Tab 1 of the live spec lists: contract, sandbox, contract suite,
  certification, disclosures, internal cohort, pilot, everyone.
- Never paste a PAN, a token, an OTP or a member's personal data into a runbook or the incident channel.
