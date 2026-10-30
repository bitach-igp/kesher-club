-- T-0629 fee items billed from I08 (REQ-INS-006): finance bills a fee to every active member, or a listed few, in
-- one call with an Idempotency-Key. The batch keeps the key and the body's fingerprint, so a retry answers the
-- batch it made; each fee item names its batch. Fee items billed before this have none.
create table org.fee_batch (
  id               uuid primary key,
  idempotency_key  text not null unique check (length(idempotency_key) between 8 and 128),
  institution_id   uuid not null references org.institution(id),
  description      text not null check (length(description) between 1 and 120),
  amount_minor     bigint not null check (amount_minor > 0),
  currency         ledger.currency not null,
  due_at           date not null,
  member_count     int not null check (member_count > 0),
  request_hash     text not null,
  created_by       uuid not null,
  created_at       timestamptz not null
);
create index on org.fee_batch (institution_id, created_at desc);

alter table org.fee_item add column batch_id uuid;
-- Every existing row has no batch, so the constraint holds without a scan.
alter table org.fee_item add constraint fee_item_batch_fk foreign key (batch_id) references org.fee_batch(id) not valid;

grant select, insert on org.fee_batch to club_app;
