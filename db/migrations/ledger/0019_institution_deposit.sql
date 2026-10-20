-- T-0614 institution deposits (REQ-INS-007): a bank transfer into Kesher's account, recorded by Kesher
-- finance against an institution and approved by a second finance member (ops.approval_request, kind
-- 'institution_deposit'), then posted once as journal 'deposit': Dr partner_settlement, Cr the
-- institution's own account. One statement line is one deposit: the rail and the bank reference are
-- unique among deposits not rejected, so a mistaken record can be rejected and recorded again.
-- institution_id carries no foreign key: org.institution is created after this schema (atlas.hcl order).
create table ops.institution_deposit (
  id               uuid primary key,
  idempotency_key  text not null unique,
  institution_id   uuid not null,
  rail             text not null check (rail in ('masav', 'wire', 'ach')),
  bank_reference   text not null check (length(bank_reference) between 1 and 64),
  amount_minor     bigint not null check (amount_minor > 0),
  currency         ledger.currency not null,
  value_date       date not null,
  note             text check (note is null or length(note) <= 500),
  status           text not null check (status in ('pending', 'posted', 'rejected')),
  approval_id      uuid,
  journal_id       uuid references ledger.journal(id),
  recorded_by      uuid not null,
  created_at       timestamptz not null,
  decided_at       timestamptz,
  check ((rail = 'masav' and currency = 'ILS') or (rail = 'ach' and currency = 'USD') or rail = 'wire')
);
create unique index institution_deposit_reference on ops.institution_deposit (rail, bank_reference) where status <> 'rejected';
create index on ops.institution_deposit (institution_id, created_at desc);
grant select, insert, update on ops.institution_deposit to club_app;

-- The kind check gains 'institution_deposit': dropped and re-added as a superset of 0018's list; NOT VALID
-- skips only the scan of existing rows, all of which satisfy the wider list.
-- The drop is re-added as a superset by the next statement in the same transaction; pre-launch, no live rows.
-- squawk-ignore ban-drop-constraint
alter table ops.approval_request drop constraint approval_request_kind_check;
alter table ops.approval_request add constraint approval_request_kind_check check (kind in ('allowance_run','payout','flag_flip','provider_binding','ledger_correction','fx_rate','staff_grant','institution_deposit')) not valid;

-- A posted deposit is a money movement like any other: an ops.transfer of kind 'deposit', settled by its
-- journal. The transfer kind check gains it the same way (superset of 0012's list, NOT VALID).
-- The drop is re-added as a superset by the next statement in the same transaction; pre-launch, no live rows.
-- squawk-ignore ban-drop-constraint
alter table ops.transfer drop constraint transfer_kind_check;
alter table ops.transfer add constraint transfer_kind_check check (kind in ('p2p','load','payout','fx','allowance','addon','refund','fee','deposit')) not valid;
