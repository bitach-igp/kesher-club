-- T-0512 club FX rates (REQ-FX-003, REQ-ADM-003)
-- One published rate per pair at a time, versioned, so a quote and a journal can name the version
-- they used (ADR-007). mid_scaled is the quote currency per one unit of the base currency × 1e6
-- (USD/ILS 3.7000 → 3700000): a fixed-point integer, never a float. A port-sourced row carries a
-- validity window; a manual row is valid until superseded and needs two finance approvers through
-- ops.approval_request, whose kind check gains 'fx_rate' (dropped and re-added as a superset; NOT
-- VALID skips only the scan of existing rows, all of which satisfy the wider list).
create table ops.fx_rate (
  id             uuid primary key,
  pair           text not null check (pair in ('USD/ILS')),
  version        int not null,
  mid_scaled     bigint not null check (mid_scaled > 0),
  source         text not null check (source in ('port','manual')),
  status         text not null check (status in ('proposed','active','superseded','rejected')),
  valid_from     timestamptz,
  valid_until    timestamptz,                         -- null: until superseded (manual rates)
  approval_id    uuid references ops.approval_request(id),
  proposed_by    text not null,                       -- staff subject, or 'worker' for port-sourced rows
  reason         text,
  created_at     timestamptz not null default now(),
  activated_at   timestamptz,
  superseded_at  timestamptz,
  unique (pair, version)
);
create unique index fx_rate_one_active_idx on ops.fx_rate (pair) where status = 'active';
create index fx_rate_pair_created_idx on ops.fx_rate (pair, created_at desc);

alter table ops.approval_request drop constraint approval_request_kind_check;
alter table ops.approval_request add constraint approval_request_kind_check check (kind in ('allowance_run','payout','flag_flip','provider_binding','ledger_correction','fx_rate')) not valid;

grant select, insert, update on ops.fx_rate to club_app;
