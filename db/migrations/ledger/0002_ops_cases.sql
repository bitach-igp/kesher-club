-- T-0203 ops cases for the balance proof and reconciliation (REQ-LED-004)
-- One row per break; dedupe_key stops a re-run from opening the same case twice.
create table ops.case (
  id          uuid primary key,
  kind        text not null,                       -- balance_break | system_total_break | unbalanced_journal | recon_break | suspense
  dedupe_key  text not null unique,
  severity    text not null check (severity in ('low','medium','high','critical')),
  status      text not null default 'open' check (status in ('open','investigating','resolved','dismissed')),
  payload     jsonb not null default '{}',
  opened_at   timestamptz not null,
  resolved_at timestamptz,
  resolved_by uuid,
  resolution  text
);
create index on ops.case (status, kind, opened_at);

-- Reconciliation breaks reference the partner record and the journal (if any) they could not match.
create table ops.recon_break (
  id              uuid primary key,
  case_id         uuid not null references ops.case(id),
  provider        text not null,
  external_id     text not null,
  journal_id      uuid references ledger.journal(id),
  partner_minor   bigint,
  partner_currency ledger.currency,
  ledger_minor    bigint,
  ledger_currency ledger.currency,
  reason          text not null,                   -- missing_journal | missing_partner | amount_mismatch | currency_mismatch
  run_date        date not null,
  created_at      timestamptz not null default now(),
  unique (provider, external_id, run_date)
);

grant select, insert, update on ops.case, ops.recon_break to club_app;
