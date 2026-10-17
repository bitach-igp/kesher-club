-- T-0401 KYC sessions and tiers (enabling)
-- The identity schema's first table. A KYC session is the provider's reference and its decision,
-- nothing else: no images, no document data, no capture token (constitution art. 9). The mobile
-- SDK's client token is returned once from the API and never written here.
create schema if not exists identity;

create table identity.kyc_session (
  session_id   text primary key,                     -- the provider's session reference
  party_id     uuid not null,
  tier         text not null check (tier in ('T1','T2')),
  market       text not null check (market in ('US','IL')),
  provider     text not null,
  status       text not null default 'pending' check (status in ('pending','approved','rejected','review')),
  reasons      text[] not null default '{}',         -- provider reason codes, no PII
  started_at   timestamptz not null,
  expires_at   timestamptz not null,
  decided_at   timestamptz,
  last_event_id text,                                -- the webhook event that produced the current status
  updated_at   timestamptz not null default now()
);
create index on identity.kyc_session (party_id, started_at desc);

grant usage on schema identity to club_app;
grant select, insert, update on identity.kyc_session to club_app;
