-- T-0636 cohorts (REQ-INS-018): an institution's cohorts, each with a start and an end date, and the placements of
-- its roster members into them. Insert-only: a member's cohort is their latest placement, and earlier ones stay as
-- history. A placement's key is per member, so a retried batch places nobody twice.
create table org.cohort (
  id               uuid primary key,
  institution_id   uuid not null references org.institution(id),
  idempotency_key  text not null unique,
  name             text not null check (length(name) between 1 and 120),
  starts_on        date not null,
  ends_on          date not null,
  created_by       uuid not null,
  created_at       timestamptz not null,
  check (ends_on > starts_on)
);
create index on org.cohort (institution_id, starts_on);

create table org.cohort_member (
  id               uuid primary key,
  -- Two placements in one millisecond tie on time; the sequence orders them.
  seq              bigint generated always as identity unique,
  cohort_id        uuid not null references org.cohort(id),
  member_id        uuid not null references org.member(id),
  idempotency_key  text not null,
  placed_by        uuid not null,
  placed_at        timestamptz not null,
  unique (idempotency_key, member_id)
);
create index on org.cohort_member (member_id, seq desc);
create index on org.cohort_member (cohort_id);

grant select, insert on org.cohort, org.cohort_member to club_app;
