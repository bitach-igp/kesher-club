-- T-0207 (REQ-LED-005): a webhook delivery whose signature fails no longer claims its event id. It was stored in
-- ops.inbound_event, whose key is (provider, event_id), so a forged delivery that arrived first left the provider's
-- genuine one answered 401 for good. Refused deliveries now go to their own table, kept for forensics and keyed by
-- nothing the provider sends; ops.inbound_event holds verified deliveries only. The forged rows already stored move
-- across in this migration (pre-launch: the simulators' tests are the only source of them).
create table ops.inbound_rejected (
  id           uuid primary key,
  provider     text not null,
  event_id     text not null,
  received_at  timestamptz not null,
  payload      jsonb not null,
  market       text not null check (market in ('IL', 'US'))
);
create index on ops.inbound_rejected (provider, event_id);
grant select, insert on ops.inbound_rejected to club_app;

-- The rows moved here get random ids: Postgres 16 has no UUIDv7, and nothing orders by them (received_at does).
insert into ops.inbound_rejected (id, provider, event_id, received_at, payload, market)
  select gen_random_uuid(), provider, event_id, received_at, payload, coalesce(market, 'IL') from ops.inbound_event where not signature_ok;
delete from ops.inbound_event where not signature_ok;
