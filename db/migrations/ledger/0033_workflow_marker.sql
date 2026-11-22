-- T-0768 ops.workflow_marker (enabling): a table for our own workflow markers (credit attempts, sub-account purpose and owner,
-- lost-race keys, payout payee links), so ops.external_ref holds vendor ids only (club-ddl rule 7). No caller is switched here (T-0769, T-0770).
-- A marker is keyed by the entity it describes (a transfer or party id), so there is no provider column. Where the old external_ref marker was
-- provider-scoped, the provider goes into kind (e.g. subaccount_owner:{provider}); credit markers are keyed by transfer id, which implies the provider.
-- primary key (kind, subject_id, seq): first writer wins per subject and attempt. value is NOT unique (an outcome or a payee id repeats across subjects).
-- claim is optional: unique (kind, claim) lets one subject take a key (a lost-race key) once per kind; NULL claims never collide.
-- ops.* is not insert-only, but markers are write-once: club_app gets select and insert only (no update, no delete).
create table ops.workflow_marker (
  kind text not null,
  subject_id uuid not null,
  seq integer not null default 0 check (seq >= 0),
  value text not null,
  claim text,
  created_at timestamptz not null default now(),
  primary key (kind, subject_id, seq),
  unique (kind, claim)
);
grant select, insert on ops.workflow_marker to club_app;
