-- T-0505 risk tiers for member transfers (REQ-PAY-002)
-- A member's P2P sending is capped by the lower of their plan's entitlement and their risk tier.
-- Tiers are ops data: a member without a row is 'new'; staff move a member with a reason that the
-- audit chain carries. Limits are per tier and currency, monthly, in minor units; usage is read from
-- ops.transfer (kind p2p, the sender's month), so there is no counter to drift.
create table ops.risk_limit (
  tier               text not null check (tier in ('new','standard','trusted')),
  currency           ledger.currency not null,
  p2p_monthly_minor  bigint not null check (p2p_monthly_minor >= 0),
  primary key (tier, currency)
);
insert into ops.risk_limit (tier, currency, p2p_monthly_minor) values
  ('new',      'ILS',  100000), ('new',      'USD',  30000),
  ('standard', 'ILS',  500000), ('standard', 'USD', 150000),
  ('trusted',  'ILS', 2000000), ('trusted',  'USD', 600000);

create table ops.risk_tier (
  party_id    uuid primary key,
  tier        text not null check (tier in ('new','standard','trusted')),
  set_by      text not null,                       -- staff SSO subject, or 'system'
  reason      text not null,
  updated_at  timestamptz not null default now()
);

grant select on ops.risk_limit to club_app;
grant select, insert, update on ops.risk_tier to club_app;
