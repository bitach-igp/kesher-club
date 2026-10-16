---
name: club-runbook
description: Write a Kesher Club operational runbook from an alert name in the build-ready spec format - trigger, first five minutes, resolution path, member message - plus owner, flags and verification. Use when adding an alert, preparing on-call docs, or after an incident.
---

# Club runbook

Runbooks live in `docs/runbooks/RUN-NN-<slug>.md`, linked from the alert itself. Index format (Tab 3 §11):

| RUN | Trigger (alert) | First five minutes | Resolution path | Member message |
|---|---|---|---|---|
| RUN-01 Provider outage | Contract-check or error-rate alert on a port | Confirm on the provider status page; flip the capability to `degraded` with banner copy; pause dependent workflows | Retry queue drains on recovery; reconcile; post-incident note | "Card top-ups are delayed. Your money is safe." |

Already defined: RUN-01 provider outage, 02 JIT latency/decline spike, 03 reconciliation break, 04 card compromise, 05 webhook backlog, 06 agent abuse, 07 data incident, 08 restore from backup. Take the next number.

## File template
```
# RUN-NN <Title>
Owner: <role, not a person> · Severity: SEV1|SEV2|SEV3 · Last tested: <date or "never">
Alert: <exact alert name and threshold>
Related: REQ-…, flags `…`, ports `…`

## First five minutes
1. Stabilise with reversible steps only: freeze, flip a flag to degraded, pause a workflow.
2. Confirm scope: market, members, provider.
3. Tell #incidents, and the bank contact when funds or cards are involved.

## Resolution path
- Root-cause steps.
- Money corrections are reversing journals with two-person approval. Never edit ledger rows.
- Re-enable flags in the order Tab 1 lists.

## Member message
"<plain words, no blame; says money is safe only if it is>" · Channel: push | email | banner | none

## Verify it is over
- Metric back under threshold for N minutes; reconciliation at zero breaks.
- Post-incident note within 2 business days.
```

Every step names the exact console, flag or command. No step needs production database writes except through the two-person correction tool. Never paste PAN, tokens or PII into a runbook or incident channel.
