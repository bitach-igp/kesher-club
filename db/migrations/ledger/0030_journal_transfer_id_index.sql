-- T-0684 index for the partner reconciliation (REQ-LED-004): the nightly job finds a transfer's journals by
-- `ledger.journal.transfer_id` (the load and refund settle, hold and release journals), and nothing indexed it, so each run
-- scanned the whole journal. Partial: most journals of non-transfer kinds carry no transfer id.
-- A plain CREATE INDEX takes a share lock on ledger.journal while it builds, which blocks inserts for that time. Atlas runs a
-- file in one transaction, where CONCURRENTLY is not allowed, and this is applied pre-launch (no live journal traffic), so the
-- lock is accepted and the rule waived for this statement. On a table with live traffic the index would go in with
-- `-- atlas:txmode none` and CONCURRENTLY instead.
-- squawk-ignore require-concurrent-index-creation
create index journal_transfer_id_idx on ledger.journal (transfer_id) where transfer_id is not null;
