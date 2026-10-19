-- T-0522 durable FX quotes (REQ-FX-001, ADR-014 decision 8) (enabling)
-- A quote lived in the memory of the API that issued it, so a second API instance behind the load
-- balancer could not convert it. Each quote is now a row: issued once per member and Idempotency-Key, read
-- by whichever instance takes the conversion, and spent once: the conversion's own Idempotency-Key claims
-- it (spent_key), so a retry under that key may still use it and no other key can. Quotes are kept as
-- the record of what the member was offered; they hold no money.
create table ops.fx_quote (
  id               text primary key,                  -- cq_{uuidv7}
  party_id         uuid not null,
  idempotency_key  text not null,
  from_minor       bigint not null check (from_minor > 0),
  from_currency    ledger.currency not null,
  to_currency      ledger.currency not null,
  rate_scaled      bigint not null check (rate_scaled > 0),
  markup_bps       bigint not null check (markup_bps >= 0),
  total_minor      bigint not null check (total_minor >= 0),
  markup_minor     bigint not null check (markup_minor >= 0),
  rate_id          uuid not null references ops.fx_rate(id),
  rate_version     int not null,
  market           text not null check (market in ('IL', 'US')),
  expires_at       timestamptz not null,
  created_at       timestamptz not null default now(),
  spent_key        text,                              -- the conversion's Idempotency-Key, once claimed
  spent_at         timestamptz,
  unique (party_id, idempotency_key),
  check (from_currency <> to_currency),
  check ((spent_key is null) = (spent_at is null))
);

grant select, insert, update on ops.fx_quote to club_app;
