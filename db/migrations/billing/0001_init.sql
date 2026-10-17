-- T-0302 billing: plans, immutable plan versions, entitlement templates, memberships, usage (enabling)
create schema if not exists billing;

create table billing.plan (
  code        text primary key,                      -- 'club', 'club-plus'
  name        text not null,
  active      boolean not null default true,
  created_at  timestamptz not null default now()
);

-- A version is immutable once created; memberships pin the version they started on (price locked for the term).
create table billing.plan_version (
  plan_code       text not null references billing.plan(code),
  version         int not null,
  price_minor     bigint not null check (price_minor >= 0),
  currency        ledger.currency not null,
  term_months     int not null check (term_months between 1 and 12),
  -- { "<key>": { "limit": "<integer as string>", "unit": "gb|calls|minor", "period": "month|term|none" } }
  entitlements    jsonb not null default '{}',
  fx_markup_bps   int not null default 75 check (fx_markup_bps between 0 and 10000),
  effective_from  timestamptz not null,
  created_at      timestamptz not null default now(),
  primary key (plan_code, version)
);

create table billing.membership (
  id                 uuid primary key,
  idempotency_key    text not null unique,
  member_party_id    uuid not null,
  funder_party_id    uuid not null,
  plan_code          text not null,
  plan_version       int not null,
  status             text not null check (status in ('incomplete','active','past_due','paused','cancelled')),
  term_months        int not null,
  price_minor        bigint not null,
  currency           ledger.currency not null,
  current_period_end timestamptz,
  paused_at          timestamptz,
  cancelled_at       timestamptz,
  dunning_attempts   int not null default 0,
  created_at         timestamptz not null default now(),
  updated_at         timestamptz not null default now(),
  foreign key (plan_code, plan_version) references billing.plan_version(plan_code, version)
);
create index on billing.membership (member_party_id);
create index on billing.membership (funder_party_id);
create index on billing.membership (status);

-- Consumption per entitlement per period; one row per (membership, key, period) upserted by consume().
create table billing.entitlement_usage (
  membership_id  uuid not null references billing.membership(id),
  key            text not null,
  period_start   date not null,
  used           bigint not null default 0,
  updated_at     timestamptz not null default now(),
  primary key (membership_id, key, period_start)
);

-- consume() is idempotent by key so a retried checkout never double-charges a credit.
create table billing.entitlement_consumption (
  idempotency_key text primary key,
  membership_id   uuid not null references billing.membership(id),
  key             text not null,
  amount          bigint not null,
  period_start    date not null,
  created_at      timestamptz not null default now()
);

grant usage on schema billing to club_app;
grant select on billing.plan, billing.plan_version to club_app;
grant select, insert, update on billing.membership, billing.entitlement_usage to club_app;
grant select, insert on billing.entitlement_consumption to club_app;
