-- T-0687 outbox publisher retries (REQ-NOT-002): a sink failure leaves the row unpublished, now with a count of the
-- failed attempts and the class of the last error (a name, never a message or payload), so ops can see a stuck message.
-- ops.outbox is not a ledger table: club_app already holds select, insert and update on it (0001). Both columns are
-- cheap to add: a constant default is a metadata-only change and the nullable column has none.
alter table ops.outbox add column attempts integer not null default 0, add column last_error_class text;
