-- T-0694 a member's Apple refresh token, sealed (REQ-AUTH-004, REQ-AUTH-005)
-- Sign in with Apple hands the app a refresh token that Apple requires us to revoke when the member closes
-- their account (T-0692). The link itself (member <-> Apple or Google subject) is an ops.external_ref row; this
-- table holds only the token, sealed app-side with the PII cipher (AES-256-GCM, the column name as associated
-- data), so the column is never readable in clear. One token per member and provider. Only Apple rows are
-- written; Google refresh tokens are out of scope. A new table, so the constraints need no NOT VALID.
create table identity.federated_token (
  party_id             uuid        not null,
  provider             text        not null check (provider in ('apple', 'google')),
  refresh_token_sealed bytea       not null,
  created_at           timestamptz not null,
  primary key (party_id, provider)
);

-- Rows are read to revoke, then deleted on unlink or erasure; never updated.
grant select, insert, delete on identity.federated_token to club_app;
