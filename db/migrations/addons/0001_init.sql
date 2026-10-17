-- T-0701 marketplace: catalogue, price rules and the addon_order lifecycle (REQ-MKT-001, REQ-MKT-002, REQ-ESIM-002)
create schema if not exists addons;

-- Price rules are the only source of prices (REQ-MKT-002): price = max(floor, cost × (1 + margin)) rounded up to .99.
create table addons.price_rule (
  id              uuid primary key,
  kind            text not null check (kind in ('esim','insurance','concierge')),
  provider        text not null,
  sku_pattern     text not null default '.*',           -- regex on the vendor sku
  margin_bps      int not null check (margin_bps between 0 and 20000),
  floor_minor     bigint not null default 0 check (floor_minor >= 0),
  currency        ledger.currency not null,
  round_to_99     boolean not null default true,
  priority        int not null default 100,             -- lower wins
  active          boolean not null default true,
  created_at      timestamptz not null default now()
);
create index on addons.price_rule (kind, provider, active, priority);

-- Catalogue items are written only by the sync job; cost and price are both recorded with the rule that set them.
create table addons.catalogue_item (
  sku             text primary key,                     -- our sku: <kind>:<provider>:<vendor sku>
  kind            text not null check (kind in ('esim','insurance','concierge')),
  provider        text not null,
  vendor_sku      text not null,
  title           text not null,
  attributes      jsonb not null default '{}',          -- { dataGb, days, country } for eSIM, product/coverage for insurance
  cost_minor      bigint not null check (cost_minor >= 0),
  price_minor     bigint not null check (price_minor >= 0),
  currency        ledger.currency not null,
  price_rule_id   uuid references addons.price_rule(id),
  active          boolean not null default true,
  synced_at       timestamptz not null,
  unique (provider, vendor_sku)
);
create index on addons.catalogue_item (kind, active);

create table addons.addon_order (
  id                 uuid primary key,
  idempotency_key    text not null unique,
  member_party_id    uuid not null,
  sku                text not null references addons.catalogue_item(sku),
  kind               text not null,
  provider           text not null,
  quantity           int not null default 1 check (quantity >= 1),
  state              text not null check (state in ('created','charged','fulfilling','fulfilled','failed','refunded')),
  cost_minor         bigint not null,
  price_minor        bigint not null,                   -- what the member pays after credit
  list_price_minor   bigint not null,                   -- catalogue price before credit
  credit_minor       bigint not null default 0,         -- entitlement credit applied (REQ-ESIM-002)
  currency           ledger.currency not null,
  charge_journal_id  uuid references ledger.journal(id),
  refund_journal_id  uuid references ledger.journal(id),
  fulfilment         jsonb,                             -- { installUrl, iccid, lpa } | { policyId, certificateUrl }
  failure_code       text,
  created_at         timestamptz not null default now(),
  updated_at         timestamptz not null default now()
);
create index on addons.addon_order (member_party_id, created_at desc);
create index on addons.addon_order (state) where state in ('charged','fulfilling');

create table addons.addon_order_event (
  id          bigint generated always as identity primary key,
  order_id    uuid not null references addons.addon_order(id),
  from_state  text,
  to_state    text not null,
  reason      text,
  at          timestamptz not null default now()
);

grant usage on schema addons to club_app;
grant select on addons.price_rule to club_app;
grant select, insert, update on addons.catalogue_item, addons.addon_order to club_app;
grant select, insert on addons.addon_order_event to club_app;
grant usage, select on all sequences in schema addons to club_app;
