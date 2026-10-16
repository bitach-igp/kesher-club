-- T-0205 transfer state machine (REQ-PAY-001, REQ-PAY-003, REQ-PAY-005); outbox rows go to ops.outbox
-- A transfer is the workflow's record; the journals it posts live in ledger.* and never change.
create table ops.transfer (
  id               uuid primary key,
  idempotency_key  text not null unique,              -- also the Temporal workflow id (constitution art. 4)
  kind             text not null check (kind in ('p2p','load','payout','fx','allowance','addon','refund')),
  from_party_id    uuid,
  to_party_id      uuid,
  amount_minor     bigint not null check (amount_minor > 0),
  currency         ledger.currency not null,
  state            text not null check (state in ('created','submitted','pending','pending_hold','settled','failed','reversed','cancelled')),
  hold_releases_at timestamptz,
  failure_code     text,
  journal_id       uuid references ledger.journal(id),
  reversal_journal_id uuid references ledger.journal(id),
  note             text,                              -- untrusted member text; never interpreted
  created_at       timestamptz not null default now(),
  updated_at       timestamptz not null default now()
);
create index on ops.transfer (from_party_id, created_at desc);
create index on ops.transfer (to_party_id, created_at desc);
create index on ops.transfer (state) where state in ('pending','pending_hold');

create table ops.transfer_event (
  id           bigint generated always as identity primary key,
  transfer_id  uuid not null references ops.transfer(id),
  from_state   text,
  to_state     text not null,
  reason       text,
  at           timestamptz not null default now()
);
create index on ops.transfer_event (transfer_id, id);
create index on ops.outbox (published_at) where published_at is null;

grant select, insert, update on ops.transfer to club_app;
grant select, insert on ops.transfer_event to club_app;
grant usage, select on all sequences in schema ops to club_app;
