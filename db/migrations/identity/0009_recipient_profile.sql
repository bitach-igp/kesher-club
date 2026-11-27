-- T-1101 recipient profile, who a member is to Israel (enabling)
-- No REQ row yet: phase 1 gap analysis, docs/ops/phase-1-gap-analysis.md.
-- Two tables. identity.recipient_profile is the member's current answer, one row per member, replaced when they change it.
-- identity.recipient_profile_history is the trail: one row appended for every change, never updated or deleted (club_app
-- gets select and insert only). `category` is a closed set held by a check (both tables are new, so there is nothing to
-- scan and no NOT VALID is needed). `program` and `israel_connection` are the member's own free text, untrusted and
-- personal: bytea written by the app's PII cipher under the column's name, never plaintext. Nothing looks a member up by
-- either value, so neither is indexed. Nothing here reaches a vendor.
create table identity.recipient_profile (
  party_id           uuid primary key,
  category           text not null check (category in ('soldier', 'lone_soldier', 'yeshiva_student', 'seminary_student', 'university_student', 'rabbi', 'volunteer', 'program_participant', 'other')),
  program            bytea,
  israel_connection  bytea,
  updated_at         timestamptz not null
);

create table identity.recipient_profile_history (
  id                 uuid primary key,
  party_id           uuid not null,
  revision           integer not null check (revision >= 1),
  category           text not null check (category in ('soldier', 'lone_soldier', 'yeshiva_student', 'seminary_student', 'university_student', 'rabbi', 'volunteer', 'program_participant', 'other')),
  program            bytea,
  israel_connection  bytea,
  recorded_at        timestamptz not null
);

-- `revision` is the member's own 1, 2, 3 ... : the app takes a per-member advisory lock, then writes max + 1, and the unique
-- index refuses a duplicate even if that ever failed. Readers order by it, never by time or id (uuidv7 ids tie within a millisecond).
create unique index recipient_profile_history_revision_idx on identity.recipient_profile_history (party_id, revision);

grant select, insert, update on identity.recipient_profile to club_app;
grant select, insert on identity.recipient_profile_history to club_app;
