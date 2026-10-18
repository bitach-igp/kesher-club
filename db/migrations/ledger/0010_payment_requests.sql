-- T-0507 payment requests and splits (REQ-PAY-004)
-- A request asks another member for money; a split is one request per other participant, grouped by
-- split_id. Paying a request runs the ordinary send (T-0505) and records its transfer here; a request
-- that is declined, or 14 days old, expires and cannot be paid. The note is member text: stored,
-- rendered, never interpreted. Money never moves through this table.
create table ops.payment_request (
  id                  uuid primary key,
  idempotency_key     text not null unique,
  requester_party_id  uuid not null,
  payer_party_id      uuid not null,
  amount_minor        bigint not null check (amount_minor > 0),
  currency            ledger.currency not null,
  note                text,                           -- untrusted member text
  split_id            uuid,
  status              text not null default 'open' check (status in ('open','paid','declined','expired','cancelled')),
  transfer_id         uuid references ops.transfer(id),
  created_at          timestamptz not null,
  expires_at          timestamptz not null,
  updated_at          timestamptz not null
);
create index on ops.payment_request (payer_party_id, status, created_at desc);
create index on ops.payment_request (requester_party_id, created_at desc);
create index on ops.payment_request (expires_at) where status = 'open';

grant select, insert, update on ops.payment_request to club_app;
