-- T-0201 ledger core (REQ-LED-001, REQ-LED-002, REQ-LED-003)
-- Ledger core (Tab 3 §6). Insert-only for club_app; corrections are reversing journals.
create schema if not exists ledger; create schema if not exists ops; create schema if not exists agent;
create type ledger.currency as enum ('USD','ILS');
create type ledger.account_type as enum
  ('wallet','pending','institution_master','partner_settlement','fx_position',
   'fee_income','interchange_income','addon_payable','suspense');

create table ledger.account (
  id             uuid primary key,
  owner_party_id uuid,
  type           ledger.account_type not null,
  currency       ledger.currency not null,
  normal_side    char(1) not null check (normal_side in ('D','C')),
  created_at     timestamptz not null default now(),
  unique (owner_party_id, type, currency)
);

create table ledger.journal (
  id              uuid primary key,
  idempotency_key text not null unique,
  kind            text not null,
  transfer_id     uuid,
  reverses_id     uuid unique references ledger.journal(id),   -- reversed at most once
  effective_at    timestamptz not null,
  metadata        jsonb not null default '{}',
  created_at      timestamptz not null default now()
);

create table ledger.posting (
  id           bigint generated always as identity primary key,
  journal_id   uuid not null references ledger.journal(id),
  account_id   uuid not null references ledger.account(id),
  currency     ledger.currency not null,
  amount_minor bigint not null check (amount_minor <> 0),
  unique (journal_id, account_id)
);
create index on ledger.posting (account_id, id);

create table ledger.account_balance (
  account_id      uuid primary key references ledger.account(id),
  balance_minor   bigint not null default 0,
  last_posting_id bigint not null default 0,
  version         bigint not null default 0
);

create function ledger.assert_balanced() returns trigger language plpgsql as $$
begin
  if exists (select 1 from ledger.posting where journal_id = new.journal_id
             group by currency having sum(amount_minor) <> 0) then
    raise exception 'UNBALANCED journal %', new.journal_id;
  end if;
  return null;
end $$;
create constraint trigger posting_balanced after insert on ledger.posting
  deferrable initially deferred for each row execute function ledger.assert_balanced();

create table ops.external_ref (
  entity_type text not null, entity_id uuid not null,
  provider text not null, external_id text not null,
  primary key (provider, external_id),
  unique (entity_type, entity_id, provider)
);

create table ops.inbound_event (
  provider text not null, event_id text not null,
  received_at timestamptz not null default now(),
  signature_ok boolean not null, payload jsonb not null,
  processed_at timestamptz, error text,
  primary key (provider, event_id)
);

create table ops.outbox (
  id bigint generated always as identity primary key,
  aggregate text not null, aggregate_id uuid not null,
  type text not null, payload jsonb not null,
  created_at timestamptz not null default now(), published_at timestamptz
);

create table agent.pending_intent (
  id uuid primary key, grant_id uuid not null, party_id uuid not null,
  kind text not null check (kind in ('p2p','load','limit_change')),
  payload jsonb not null,
  status text not null default 'pending' check (status in ('pending','approved','rejected','expired')),
  expires_at timestamptz not null, decided_at timestamptz, decided_by uuid
);

-- Grants (roles created in db/roles.sql)
revoke update, delete, truncate on all tables in schema ledger from club_app;
grant usage on schema ledger, ops, agent to club_app;
grant select, insert on all tables in schema ledger to club_app;
grant update on ledger.account_balance to club_app;
grant select, insert, update on all tables in schema ops, agent to club_app;
