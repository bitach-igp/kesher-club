# RUN-05 Webhook backlog
Owner: on-call engineer · Severity: SEV2 · Last tested: never
Alert: `webhook_lag` (newest unprocessed `ops.inbound_event` older than 5 minutes), `temporal_backlog` (over 1,000 tasks)
Related: REQ-LED-003, REQ-NOT-002; every port that sends webhooks (`/hooks/{provider}`)

## First five minutes
1. Is ingress healthy? Check 5xx on `/hooks/*` in the API panel. A 5xx means the provider is retrying and we are not storing; a 2xx with lag means we store but do not process.
2. Check worker health: the consumer that drains `ops.inbound_event` is in `apps/worker`; a crashed worker is the usual cause. Restart it; scale the worker service's desired count if the queue is large.
3. Nothing to flip: a backlog is safe. Events are stored first and processed by `(provider, event id)`, so a late event is still an exact event (REQ-LED-003).
4. Tell `#incidents` with the lag and the provider.

## Resolution path
- Replay: unprocessed rows in `ops.inbound_event` are reprocessed by the worker once it is back; for a row the worker refuses, the admin replay path re-runs its verifier and processor with the same event id, so a duplicate is a no-op.
- Verify dedupe after a replay: one journal per event id (`ledger.journal.idempotency_key`), one transfer transition per event.
- If a provider's signature verification is what failed (a rotated secret), rotate ours in the secrets manager and replay; the stored body is intact for forensics.
- A Temporal backlog over 1,000 without a worker crash means a workflow is looping: find it by workflow id in the Temporal console and terminate it; the sweep picks the transfer up by its key.

## Member message
— (none; delays under an hour are inside the product's promises) · Channel: none

## Verify it is over
- Lag under one minute for 15 minutes; the Temporal backlog under 100.
- Zero unprocessed rows older than 5 minutes in `ops.inbound_event`.
- Reconciliation at zero breaks on the next run.
