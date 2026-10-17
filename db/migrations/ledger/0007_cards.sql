-- T-0402 cards and wallet tokens (REQ-CRD-001, REQ-CRD-002)
-- Our record of a card is the processor's reference, its status, controls and the last four digits.
-- PAN, CVV and expiry never exist on our side (REQ-CRD-002): the processor renders them from a
-- short-lived details token. club_jit reads here on the authorisation path (T-0403) and never writes.
create schema if not exists cards;

create table cards.card (
  id                 uuid primary key,
  party_id           uuid not null,
  processor          text not null,                  -- the CardIssuingPort binding that issued it
  processor_card_id  text not null unique,
  cardholder_id      text not null,
  type               text not null check (type in ('virtual','physical')),
  status             text not null check (status in ('inactive','active','frozen','closed')),
  last4              text not null check (last4 ~ '^[0-9A-Za-z_]{4}$'),
  currency           ledger.currency not null,
  controls           jsonb not null default '{}',    -- CardControls in wire form; limits as minor-unit strings
  locked_by_funder   text[] not null default '{}',   -- control keys the funder set (REQ-CRD-005)
  workflow_id        text not null unique,           -- the issue workflow's id; its idempotency key
  issued_at          timestamptz not null,
  updated_at         timestamptz not null default now()
);
create index on cards.card (party_id);

-- Wallet tokens the processor reports (REQ-CRD-006/007); lifecycle webhooks keep status current.
create table cards.card_token (
  token_id       text primary key,
  card_id        uuid not null references cards.card(id),
  wallet         text not null check (wallet in ('apple','google')),
  device_id      text not null,
  status         text not null check (status in ('active','suspended','deleted')),
  last_event_id  text,
  updated_at     timestamptz not null default now()
);
create index on cards.card_token (card_id);

grant usage on schema cards to club_app, club_jit;
grant select, insert, update on cards.card, cards.card_token to club_app;
grant select on cards.card, cards.card_token to club_jit;
