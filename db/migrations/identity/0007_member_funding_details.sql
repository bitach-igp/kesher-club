-- T-0738 member funding details, ADR-018 option 2 (REQ-WAL-002)
-- What a member types once so a sub-account can be opened for them: the owner contact (legal first and last name,
-- email, optional date of birth) or, instead, an invitation email only. Every value is personal data (class P1,
-- constitution art. 9): bytea written by the app's PII cipher under its column's name, never plaintext. One row per
-- member, replaced when they change it. A row holds either the whole owner (first and last name together, the date of
-- birth only with them) or just the email: the check keeps the two shapes apart. Nothing looks a member up by these
-- values, so there is no index on any of them. The phone is not copied here: the reader takes it from the account row.
create table identity.member_funding_details (
  party_id       uuid primary key,
  first_name     bytea,
  last_name      bytea,
  email          bytea not null,
  date_of_birth  bytea,
  updated_at     timestamptz not null,
  constraint member_funding_details_shape check (
    (first_name is null) = (last_name is null)
    and (first_name is not null or date_of_birth is null)
  )
);

grant select, insert, update on identity.member_funding_details to club_app;
