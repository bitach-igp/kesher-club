-- T-0632 self-serve institution applications (REQ-INS-016). Decision 2: a signed-in person with no institution
-- applies for their organisation: the application names the entity; its signatories are org.kyb_person rows the
-- applicant records; the own-name account the applicant proposes and each submission are events. Insert-only: an
-- application is never edited, its status is read from its events and the institution's KYB decisions. One
-- application per person.
create table org.institution_application (
  id                   uuid primary key,
  institution_id       uuid not null unique references org.institution(id),
  applicant_party_id   uuid not null unique,
  idempotency_key      text not null unique,
  legal_name           text not null check (length(legal_name) between 1 and 200),
  registration_number  text not null check (length(registration_number) between 1 and 40),
  address              jsonb not null,
  created_at           timestamptz not null
);

create table org.institution_application_event (
  id              uuid primary key,
  -- Two events in one millisecond tie on time; the sequence orders them.
  seq             bigint generated always as identity unique,
  application_id  uuid not null references org.institution_application(id),
  kind            text not null check (kind in ('account_proposed', 'submitted')),
  payload         jsonb not null default '{}',
  by_party        uuid not null,
  at              timestamptz not null
);
create index on org.institution_application_event (application_id, seq desc);

grant select, insert on org.institution_application, org.institution_application_event to club_app;
