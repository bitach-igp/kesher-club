-- T-1001 agent access: CIMD clients, grants, call audit (REQ-AGT-003, REQ-AGT-008, REQ-AGT-009)
-- agent.pending_intent is created in ledger/0001_init.sql.

create table agent.client (
  client_id      text primary key,                   -- the Client ID Metadata Document URL (https)
  name           text not null,
  metadata       jsonb not null,                     -- the fetched document, size-capped
  fetched_at     timestamptz not null,
  status         text not null default 'active' check (status in ('active','blocked')),
  blocked_reason text
);

create table agent.grant (
  id            uuid primary key,
  client_id     text not null references agent.client(client_id),
  party_id      uuid not null,
  scopes        text[] not null,
  status        text not null default 'active' check (status in ('active','revoked')),
  created_at    timestamptz not null,
  last_used_at  timestamptz,
  revoked_at    timestamptz
);
create index on agent.grant (party_id, status);
create index on agent.grant (client_id);

-- Every tool call, for the 60/min limit and the audit trail (REQ-AGT-009). Insert-only.
create table agent.call (
  id          bigint generated always as identity primary key,
  grant_id    uuid not null references agent.grant(id),
  client_id   text not null,
  tool        text not null,
  status      int not null,                          -- HTTP status returned
  at          timestamptz not null
);
create index on agent.call (grant_id, at desc);

grant select, insert, update on agent.client, agent.grant to club_app;
grant select, insert on agent.call to club_app;
grant usage, select on all sequences in schema agent to club_app;
