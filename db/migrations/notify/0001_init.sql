-- T-0801 notification preferences; T-0803 outbound webhook endpoints (REQ-NOT-001, REQ-NOT-002)
create schema if not exists notify;

create table notify.preference (
  party_id     uuid primary key,
  -- { "<category>": ["push","email"] }; absent category = all channels
  channels     jsonb not null default '{}',
  opt_out      text[] not null default '{}',          -- never 'security' or 'emergency'
  time_zone    text not null default 'Asia/Jerusalem',
  quiet_start  text not null default '23:00',
  quiet_end    text not null default '07:00',
  updated_at   timestamptz not null default now(),
  check (not ('security' = any(opt_out)) and not ('emergency' = any(opt_out)))
);

-- Outbound endpoints per institution. The signing secret lives at the EventsPort provider (Svix) or,
-- for the in-house adapter, in Secrets Manager under the endpoint id; never in this table.
create table notify.outbound_endpoint (
  endpoint_id     text primary key,                   -- the port's id
  institution_id  uuid not null references org.institution(id),
  url             text not null,
  event_types     text[] not null,
  active          boolean not null default true,
  created_by      uuid not null,
  created_at      timestamptz not null default now(),
  rotated_at      timestamptz
);
create index on notify.outbound_endpoint (institution_id, active);

-- Our record of each outbound message (the port keeps attempts); lets the replay UI list by institution.
create table notify.outbound_message (
  message_id      text primary key,
  outbox_id       bigint not null unique,
  institution_id  uuid not null,
  event_type      text not null,
  sent_at         timestamptz not null
);
create index on notify.outbound_message (institution_id, sent_at desc);

grant usage on schema notify to club_app;
grant select, insert, update on notify.preference, notify.outbound_endpoint to club_app;
grant select, insert on notify.outbound_message to club_app;
