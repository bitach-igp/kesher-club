-- T-0924 admins onboard institutions (REQ-ADM-004). A create is idempotent by its key; the key lives
-- here, next to the institution it made, so a retried create answers the same institution and the
-- institution keeps its UUIDv7 id. Insert-only: an onboarding is a fact, never edited.
create table org.institution_onboarding (
  idempotency_key  text primary key,
  institution_id   uuid not null unique references org.institution(id),
  created_by       uuid not null,
  created_at       timestamptz not null
);

grant select, insert on org.institution_onboarding to club_app;
