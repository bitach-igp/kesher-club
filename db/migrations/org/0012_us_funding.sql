-- T-0653 fund the master account from the linked US account (REQ-INS-024): a finance user asks for a quote, requests the funding with it, and a
-- second finance user or admin approves. The quote is spent by the request that uses it (unique quote_id), so a late approval cannot fail on
-- an expired quote. A request's life is an insert-only event log: requested, approved, sent (the provider's payment ref lives in ops.external_ref,
-- not here), ach_status, book_transferred, deposit_recorded, linked, cancelled, failed. Nothing here posts money: the master account is credited
-- only by the existing deposit path (T-0614, T-0618) when the money arrives with the institution's KC- reference.
create table org.us_funding_quote (
  id              uuid primary key,
  institution_id  uuid not null references org.institution(id),
  amount_minor    bigint not null check (amount_minor > 0),
  fee_minor       bigint not null check (fee_minor >= 0),
  currency        text not null check (currency = 'USD'),
  arrives_on      date,
  expires_at      timestamptz not null,
  created_by      uuid not null,
  created_at      timestamptz not null
);

create table org.us_funding_request (
  id               uuid primary key,
  institution_id   uuid not null references org.institution(id),
  idempotency_key  text not null,
  quote_id         uuid not null unique references org.us_funding_quote(id),
  holder           text not null check (holder in ('platform', 'institution')),
  amount_minor     bigint not null check (amount_minor > 0),
  currency         text not null check (currency = 'USD'),
  -- The institution's payment reference ("KC-7M4QX2HD"), the one its deposits are found by.
  reference        text not null,
  requested_by     uuid not null,
  created_at       timestamptz not null,
  unique (institution_id, idempotency_key)
);
create index on org.us_funding_request (institution_id, created_at desc);

create table org.us_funding_event (
  id          uuid primary key,
  -- Two events in one millisecond tie on time; the sequence orders them.
  seq         bigint generated always as identity unique,
  request_id  uuid not null references org.us_funding_request(id),
  kind        text not null check (kind in ('requested', 'approved', 'sending', 'sent', 'send_unknown', 'ach_status', 'book_transferred', 'deposit_recorded', 'linked', 'cancelled', 'failed')),
  by_party    uuid,
  payload     jsonb not null default '{}',
  at          timestamptz not null
);
create index on org.us_funding_event (request_id, seq);

grant select, insert on org.us_funding_quote, org.us_funding_request, org.us_funding_event to club_app;
