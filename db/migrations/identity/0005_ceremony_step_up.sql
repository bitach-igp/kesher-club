-- T-0682 passkey ceremonies and step-up tokens in Postgres (REQ-AUTH-006, REQ-AUTH-007)
-- Both lived in process memory, so with two API tasks a ceremony started on one and finished on the other
-- failed, and a restart dropped every step-up. A ceremony is one pending passkey challenge: `session_id`
-- is the lookup key the service chose (the session for a step-up, a hash of device and otp-session for a
-- registration, the device for a sign-in), `kind` says which, and there is one live ceremony per
-- (kind, key): starting again replaces it. It is single-use: consumed_at is set by the take. The step-up
-- token is stored only as a SHA-256 hash, one per session. New tables, so every constraint is validated
-- on an empty table and nothing needs NOT VALID.
create table identity.passkey_ceremony (
  ceremony_id uuid primary key,
  kind        text not null check (kind in ('registration', 'authentication', 'step_up')),
  session_id  text not null,
  party_id    text not null,
  options     jsonb not null,
  issued_at   timestamptz not null,
  consumed_at timestamptz,
  unique (kind, session_id)
);
create index on identity.passkey_ceremony (issued_at);

create table identity.step_up_token (
  session_id text primary key,                      -- text: staff sessions are not uuids
  token_hash text not null,
  expires_at timestamptz not null
);
create index on identity.step_up_token (expires_at);

-- Expired rows are deleted on write and on read, so club_app deletes from these two tables only.
grant select, insert, update, delete on identity.passkey_ceremony, identity.step_up_token to club_app;
