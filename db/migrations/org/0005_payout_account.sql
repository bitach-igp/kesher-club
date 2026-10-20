-- T-0623 institution payout accounts (REQ-INS-012), as ADR-017 sets out: an institution pays out only to a bank
-- account verified as held in its registered name. Compliance records the account with the holder name its
-- bank's ownership letter states and a reference to that letter. The account takes effect only when a
-- different compliance member approves it, and a replacement waits the same way, so payouts stop until it is
-- approved. Insert-only: a recorded account and its approval are facts; the current account is the latest
-- approved one.
create table org.payout_account (
  id               uuid primary key,
  seq              bigint generated always as identity unique,
  institution_id   uuid not null references org.institution(id),
  idempotency_key  text not null unique,
  currency         ledger.currency not null,
  iban             text not null check (iban ~ '^[A-Z]{2}[0-9]{2}[0-9A-Z]{8,30}$'),
  holder_name      text not null check (length(holder_name) between 1 and 200),
  evidence_ref     text not null check (length(evidence_ref) between 1 and 500),
  recorded_by      uuid not null,
  recorded_at      timestamptz not null
);
create index on org.payout_account (institution_id, currency, seq desc);

create table org.payout_account_approval (
  account_id       uuid primary key references org.payout_account(id),
  approved_by      uuid not null,
  approved_at      timestamptz not null
);

grant select, insert on org.payout_account, org.payout_account_approval to club_app;
