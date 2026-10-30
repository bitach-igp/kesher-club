-- T-0627 allowance schedules created in I07 (REQ-INS-003): the finance member's create call carries an
-- Idempotency-Key, and a retry with that key must answer the schedule it already made. The key lives beside
-- the schedule, not on it, so the existing table takes no new column or index: one row per key, with the
-- request's fingerprint, so the same key with a different body is told apart from a retry.
create table org.allowance_schedule_request (
  idempotency_key  text primary key check (length(idempotency_key) between 8 and 128),
  institution_id   uuid not null references org.institution(id),
  schedule_id      uuid not null unique references org.allowance_schedule(id),
  request_hash     text not null,
  created_by       uuid not null,
  created_at       timestamptz not null
);
create index on org.allowance_schedule_request (institution_id);

grant select, insert on org.allowance_schedule_request to club_app;
