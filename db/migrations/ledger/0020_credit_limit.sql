-- T-0616 institution credit limits (REQ-INS-008): how far below zero an institution's own account may go
-- to pay allowances, per currency. One admin proposes a limit and a second approves it
-- (ops.approval_request, kind 'credit_limit'); each approved limit is a new row, never an update, so the
-- history of who allowed what stays. The current limit is the latest row for (institution, currency);
-- none means ₪0 / $0. Payouts never use it.
-- institution_id carries no foreign key: org.institution is created after this schema (atlas.hcl order).
create table ops.institution_credit_limit (
  id              uuid primary key,
  institution_id  uuid not null,
  currency        ledger.currency not null,
  limit_minor     bigint not null check (limit_minor >= 0),
  approval_id     uuid not null unique,
  set_at          timestamptz not null
);
create index on ops.institution_credit_limit (institution_id, currency, set_at desc);
grant select, insert on ops.institution_credit_limit to club_app;

-- The kind check gains 'credit_limit': dropped and re-added as a superset of 0019's list; NOT VALID
-- skips only the scan of existing rows, all of which satisfy the wider list.
-- The drop is re-added as a superset by the next statement in the same transaction; pre-launch, no live rows.
-- squawk-ignore ban-drop-constraint
alter table ops.approval_request drop constraint approval_request_kind_check;
alter table ops.approval_request add constraint approval_request_kind_check check (kind in ('allowance_run','payout','flag_flip','provider_binding','ledger_correction','fx_rate','staff_grant','institution_deposit','credit_limit')) not valid;
