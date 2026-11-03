-- T-0652 fees to US funders (REQ-INS-023): a fee item may be collected on the provider's payment page, into the institution's own US account.
-- That money never touches Kesher's ledger. `fee_us_collect` marks the items collected in the US (insert-only, one row an item); the provider's
-- ids for the collection and each payment page live in ops.external_ref. `fee_external_payment` is the insert-only record of what the provider
-- says was paid or refunded, unique on the provider's payment ref per kind so a payment marks its item paid exactly once. The funder's name,
-- email and mobile are sent to the provider and not stored.
create table org.fee_us_collect (
  fee_item_id     uuid primary key references org.fee_item(id),
  institution_id  uuid not null references org.institution(id),
  batch_id        uuid not null references org.fee_batch(id),
  requested_by    uuid not null,
  created_at      timestamptz not null
);
create index on org.fee_us_collect (batch_id);

create table org.fee_external_payment (
  id                   uuid primary key,
  seq                  bigint generated always as identity unique,
  fee_item_id          uuid not null references org.fee_item(id),
  kind                 text not null check (kind in ('payment', 'refund')),
  provider_payment_ref text not null check (length(provider_payment_ref) between 1 and 200),
  amount_minor         bigint not null check (amount_minor > 0),
  currency             text not null check (currency = 'USD'),
  at                   timestamptz not null,
  unique (provider_payment_ref, kind)
);
create index on org.fee_external_payment (fee_item_id, seq);

grant select, insert on org.fee_us_collect, org.fee_external_payment to club_app;
