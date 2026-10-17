-- T-0903 hash-chained admin audit (REQ-ADM-001); T-0905 flag state with two-person flips (REQ-ADM-002)
create schema if not exists audit;

-- Append-only. Each row's hash covers its own fields plus the previous row's hash; the verification
-- job recomputes the chain and fails on any edited, deleted or reordered row.
create table audit.entry (
  seq          bigint generated always as identity primary key,
  id           uuid not null unique,
  actor_id     uuid not null,
  actor_role   text not null,
  action       text not null,                      -- flag.flip, binding.change, member.freeze, case.resolve …
  subject      text not null,
  reason       text not null,
  before_hash  text,                               -- sha256 of the subject's state before (never the PII itself)
  after_hash   text,
  payload      jsonb not null default '{}',        -- non-PII context (keys, ids, amounts)
  at           timestamptz not null,
  prev_hash    text not null,                      -- hash of the previous row ('genesis' for the first)
  hash         text not null unique
);

-- Current flag values. config/flags.json stays the registry (which flags exist and their defaults);
-- this table holds environment overrides, each written only through an approved request.
create table ops.flag_state (
  key          text primary key,
  value        boolean not null,
  changed_at   timestamptz not null,
  approval_id  uuid not null references ops.approval_request(id),
  audit_id     uuid not null references audit.entry(id)
);

grant usage on schema audit to club_app;
grant select, insert on audit.entry to club_app;
grant select, insert, update on ops.flag_state to club_app;
grant usage, select on all sequences in schema audit to club_app;
