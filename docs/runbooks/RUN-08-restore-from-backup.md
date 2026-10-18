# RUN-08 Restore from backup
Owner: on-call engineer, with finance on-call · Severity: SEV1 · Last tested: never
Alert: DR declared by the on-call engineer and one founder after data loss or corruption that a correction cannot fix
Related: REQ-LED-001, REQ-LED-004; every money flag; `ops.account_balance`; `infra/terraform` (RDS, PITR with RPO 5 minutes)

## First five minutes
1. Stop writes: flip every money flag off through two admins, then the maintenance banner; the API answers `FEATURE_OFF` for money and the app shows the status page.
2. Pick the restore point: the last moment before the loss, in UTC, from the incident timeline. Say it in `#incidents` before restoring.
3. Restore PITR to a new RDS instance; never over the live one. The live instance is evidence.
4. Tell the bank contact: money features are paused for a restore.

## Resolution path
- Ledger first: on the restored instance, run the migrations to the current version (`node db/migrate.mjs`), then the balance proof (`BalanceProof`). The proof must pass before anything else; if it does not, the restore point is wrong.
- Rebuild the balance cache only here: `rebuildBalanceCache` runs under `club_migrator` with the money flags off and rewrites `ops.account_balance` from the postings. It is the one time the cache is written outside the app.
- Reconcile against every provider for the window since the restore point (`ReconJob` per provider); every transfer the providers settled that the restored ledger lacks becomes a case, and a journal with two-person approval.
- Point the app at the restored instance; re-enable flags in the order Tab 1 lists, each with two admins, checking reconciliation after each.
- Keep the old instance for 30 days.

## Member message
Status page: "We paused payments and cards for maintenance at {time}. Balances will be back shortly; nothing is lost." Update it every 30 minutes until done. · Channel: banner and status page

## Verify it is over
- Balance proof passing; reconciliation at zero breaks for every provider over the window.
- Every money flag back on; the maintenance banner off.
- Post-incident note within 2 business days, with the RPO actually achieved.
