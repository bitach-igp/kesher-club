# RUN-02 JIT latency or decline spike
Owner: on-call engineer · Severity: SEV1 (members are being declined at the till) · Last tested: never
Alert: `jit_p99_over_300ms` (p99 over 300 ms for 5 minutes), `jit_error_rate` (over 1%), `rds_cpu_high` (over 80% for 15 minutes)
Related: REQ-CRD-003, REQ-CRD-004; flags `card.virtual`, `card.physical`; port `CardIssuingPort`

## First five minutes
1. Confirm the processor stand-in is active: the JIT service fails closed, so when we are slow the processor must be declining on our behalf with its stand-in rules, not timing out silently. Check the processor's console for stand-in mode.
2. Check replica lag and database CPU on the RDS panel. Lag over a few seconds means the decision service is reading stale balances; CPU over 80% means it is waiting.
3. Scale the jit service: raise the ECS desired count for the `jit` service in the infra console (`infra/terraform` holds the numbers; the change is a count, not a redeploy).
4. If the decline rate is the problem and the service is healthy, look at the last deploy and the last flag flip in `listAdminAudit`; a rule change can decline everyone.
5. Tell `#incidents` and the bank contact: members are being declined.

## Resolution path
- Root cause from traces: the decision path is one read of `ops.account_balance` plus the card controls; anything slower than that is the finding.
- Load-test the fix against staging with the JIT fixture before it ships; the SLO is p99 under 300 ms at 200 decisions per second (TST-CRD-003).
- Roll back a deploy or a flag flip rather than hot-fix forward during the incident.
- Declines that were wrong are not money movements; nothing to correct on the ledger. Authorisations that went through on stand-in reconcile at settlement.

## Member message
Push to affected members only: "Some card payments were declined for a few minutes. Your card and balance are fine; please try again." · Channel: push

## Verify it is over
- p99 under 300 ms and error rate under 1% for 15 minutes; stand-in mode off at the processor.
- Settlement reconciliation at zero breaks for the window.
- Post-incident note within 2 business days with the trace that shows the cause.
