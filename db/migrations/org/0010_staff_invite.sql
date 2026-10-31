-- T-0643 team and roles (REQ-INS-020): an institution admin invites staff by email or phone, and the invitee accepts
-- signed in. The address is kept only as its sha256 (the message carries it); the link's token only as its sha256.
-- Insert-only: an acceptance is a fact of its own, never an update to the invite. Roles that move money or people
-- (finance, admin) land through the shared two-person approvals, not here.
create table org.staff_invite (
  id               uuid primary key,
  institution_id   uuid not null references org.institution(id),
  idempotency_key  text not null unique,
  role             text not null check (role in ('admin', 'finance', 'staff')),
  channel          text not null check (channel in ('email', 'sms')),
  recipient_hash   text not null,
  token_hash       text not null unique,
  invited_by       uuid not null,
  sent_at          timestamptz not null,
  expires_at       timestamptz not null
);
create index on org.staff_invite (institution_id, sent_at desc);

create table org.staff_invite_acceptance (
  invite_id    uuid primary key references org.staff_invite(id),
  party_id     uuid not null,
  accepted_at  timestamptz not null
);

grant select, insert on org.staff_invite, org.staff_invite_acceptance to club_app;
