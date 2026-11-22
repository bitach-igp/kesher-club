-- T-0768 ops.workflow_marker (enabling): a table for our own workflow markers (credit attempts, sub-account purpose and owner,
-- lost-race keys, payout payee links), so ops.external_ref holds vendor ids only (club-ddl rule 7). No caller is switched here (T-0769, T-0770).
-- A marker is keyed by the entity it describes (a transfer or party id), so there is no provider column to collide on.
-- primary key (kind, subject_id, seq): first writer wins per subject and attempt. unique (kind, value): a value (a lost-race key) is looked up and claimed once per kind.
-- ops.* is not insert-only, but markers are write-once: club_app gets select and insert only (no update, no delete).
create table ops.workflow_marker (
  kind text not null,
  subject_id uuid not null,
  seq integer not null default 0 check (seq >= 0),
  value text not null,
  created_at timestamptz not null default now(),
  primary key (kind, subject_id, seq),
  unique (kind, value)
);
grant select, insert on ops.workflow_marker to club_app;
