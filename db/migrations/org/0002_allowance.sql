-- T-0604 allowance schedules and runs (REQ-INS-003, REQ-INS-004)
create table org.allowance_schedule (
  id               uuid primary key,
  institution_id   uuid not null references org.institution(id),
  name             text not null,
  amount_minor     bigint not null check (amount_minor > 0),
  currency         ledger.currency not null,
  cadence          text not null check (cadence in ('weekly','monthly','once')),
  -- member_party_ids the schedule pays; empty = every active member of the institution
  member_filter    jsonb not null default '[]',
  active           boolean not null default true,
  created_by       uuid not null,
  created_at       timestamptz not null default now()
);
create index on org.allowance_schedule (institution_id, active);

-- One run per (schedule, date): the Temporal workflow id allowance:{schedule}:{date}.
create table org.allowance_run (
  workflow_id      text primary key,
  schedule_id      uuid not null references org.allowance_schedule(id),
  run_date         date not null,
  status           text not null check (status in ('preview','awaiting_second_approval','running','completed','failed')),
  member_count     int not null,
  total_minor      bigint not null,
  currency         ledger.currency not null,
  approval_id      uuid,
  failures         int not null default 0,
  started_at       timestamptz,
  completed_at     timestamptz,
  created_at       timestamptz not null default now(),
  unique (schedule_id, run_date)
);

-- One child row per member per run; the transfer key is deterministic so a rerun pays nobody twice.
create table org.allowance_payment (
  workflow_id      text not null references org.allowance_run(workflow_id),
  member_party_id  uuid not null,
  transfer_key     text not null unique,
  status           text not null check (status in ('pending','paid','failed')),
  attempts         int not null default 0,
  error            text,
  journal_id       uuid references ledger.journal(id),
  updated_at       timestamptz not null default now(),
  primary key (workflow_id, member_party_id)
);

grant select, insert, update on org.allowance_schedule, org.allowance_run, org.allowance_payment to club_app;
