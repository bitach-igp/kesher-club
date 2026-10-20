-- T-0619 institution KYB (REQ-INS-011), as ADR-017 sets it out: the people in an institution's record, every check with
-- its evidence reference, the disposition of each screening hit, and the decisions. Checks, dispositions
-- and decisions are insert-only facts: the current state is the latest row. Nothing here holds a document,
-- an image or an identity number; evidence is a reference to where compliance or the provider keeps it.
create table org.kyb_person (
  id               uuid primary key,
  institution_id   uuid not null references org.institution(id),
  idempotency_key  text unique,
  full_name        text not null check (length(full_name) between 1 and 200),
  roles            text[] not null check (cardinality(roles) > 0 and roles <@ array['board', 'control', 'signatory']),
  party_id         uuid,
  created_by       uuid not null,
  created_at       timestamptz not null
);
create index on org.kyb_person (institution_id);

create table org.kyb_check (
  id               uuid primary key,
  -- The order checks were recorded in: two in one millisecond tie on time, and a UUIDv7 does not break the tie.
  seq              bigint generated always as identity unique,
  institution_id   uuid not null references org.institution(id),
  person_id        uuid references org.kyb_person(id),
  kind             text not null check (kind in ('registry', 'identifier', 'exempt_status', 'sanctions', 'pep')),
  result           text not null check (result in ('clear', 'hit', 'missing', 'excepted')),
  provider         text not null,
  evidence_ref     text check (evidence_ref is null or length(evidence_ref) <= 500),
  detail           jsonb not null default '{}',
  recorded_by      uuid,
  checked_at       timestamptz not null,
  -- An exception is compliance's call and always says why.
  check (result <> 'excepted' or detail ? 'reason')
);
create index on org.kyb_check (institution_id, kind, checked_at desc);

create table org.kyb_disposition (
  id               uuid primary key,
  check_id         uuid not null unique references org.kyb_check(id),
  outcome          text not null check (outcome in ('false_positive', 'true_match')),
  note             text not null check (length(note) between 1 and 1000),
  decided_by       uuid not null,
  decided_at       timestamptz not null
);

create table org.kyb_decision (
  id               uuid primary key,
  seq              bigint generated always as identity unique,
  institution_id   uuid not null references org.institution(id),
  idempotency_key  text unique,
  status           text not null check (status in ('needs_more_info', 'approved_with_limits', 'approved', 'rejected')),
  risk             text check (risk in ('low', 'medium', 'high')),
  reasons          text[] not null default '{}',
  approval_id      uuid unique,
  decided_by       uuid not null,
  decided_at       timestamptz not null,
  -- An approval always carries the risk it was approved at.
  check (status not in ('approved', 'approved_with_limits') or risk is not null)
);
create index on org.kyb_decision (institution_id, decided_at desc);

-- A person's member party is linked once they sign up; nothing else about a person changes.
grant select, insert on org.kyb_person, org.kyb_check, org.kyb_disposition, org.kyb_decision to club_app;
grant update (party_id) on org.kyb_person to club_app;
