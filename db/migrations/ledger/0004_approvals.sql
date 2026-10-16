-- T-0605 two-person approvals (REQ-INS-004, REQ-ADM-002)
-- One request per action that needs a second pair of eyes: allowance runs and payouts over ₪5,000,
-- money flag flips and provider bindings. Decisions are insert-only; the request row carries the state.
create table ops.approval_request (
  id              uuid primary key,
  kind            text not null check (kind in ('allowance_run','payout','flag_flip','provider_binding','ledger_correction')),
  subject         text not null,                        -- workflow id, payout id, flag key…
  payload         jsonb not null default '{}',
  amount_minor    bigint,
  currency        ledger.currency,
  required        int not null check (required between 1 and 3),
  scope           text not null,                        -- institution id, or 'platform' for admin actions
  requested_by    uuid not null,
  status          text not null check (status in ('pending','awaiting_second_approval','approved','rejected','expired')),
  expires_at      timestamptz not null,
  created_at      timestamptz not null default now(),
  decided_at      timestamptz,
  unique (kind, subject)
);
create index on ops.approval_request (scope, status, created_at desc);

create table ops.approval_decision (
  id           uuid primary key,
  request_id   uuid not null references ops.approval_request(id),
  decided_by   uuid not null,
  role         text not null,
  decision     text not null check (decision in ('approve','reject')),
  reason       text,
  at           timestamptz not null default now(),
  unique (request_id, decided_by)                        -- one person decides once
);

grant select, insert, update on ops.approval_request to club_app;
grant select, insert on ops.approval_decision to club_app;
