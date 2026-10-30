-- T-1014 the MCP authorization server's own records (REQ-AGT-010, REQ-AGT-011)
-- ADR-009: the API issues assistant tokens itself. An authorization request lives from the assistant's
-- redirect until the member decides (T-1015) or 10 minutes pass. The one-time code, stored only as a SHA-256
-- hash, lives 60 seconds after approval. Refresh tokens (T-1016) are stored only as hashes. They rotate in a
-- family, so a replayed one shows which grant to revoke. Nothing here is a member's personal data beyond the
-- party id.
create table agent.authorization_request (
  id               uuid primary key,
  client_id        text not null references agent.client(client_id),
  redirect_uri     text not null,
  scopes           text[] not null,
  state            text not null check (length(state) between 1 and 512),
  code_challenge   text not null check (code_challenge ~ '^[A-Za-z0-9_-]{43}$'),
  resource         text not null,
  status           text not null default 'pending' check (status in ('pending', 'approved', 'denied', 'exchanged')),
  party_id         uuid,
  grant_id         uuid references agent.grant(id),
  code_hash        bytea unique,
  code_expires_at  timestamptz,
  created_at       timestamptz not null,
  expires_at       timestamptz not null,
  decided_at       timestamptz,
  -- An approval carries who approved, the grant and its code; a pending request carries none of them.
  check (status <> 'approved' or (party_id is not null and grant_id is not null and code_hash is not null and code_expires_at is not null))
);
create index on agent.authorization_request (client_id);
create index on agent.authorization_request (grant_id);

create table agent.refresh_token (
  token_hash   bytea primary key,
  grant_id     uuid not null references agent.grant(id),
  family       uuid not null,
  issued_at    timestamptz not null,
  expires_at   timestamptz not null,
  rotated_at   timestamptz
);
create index on agent.refresh_token (grant_id);
create index on agent.refresh_token (family);

grant select, insert, update on agent.authorization_request, agent.refresh_token to club_app;
