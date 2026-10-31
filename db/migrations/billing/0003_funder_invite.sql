-- T-0306 funder invites (REQ-BIL-002): a funder with approved T1 invites a member, by phone or email, onto the plan
-- version offered when they sent it. Nothing is charged until the member accepts (T-0307), and the funder's card
-- stays with the billing vendor on their customer, so no vendor id is kept here. The link's token is stored as
-- its hash only. An invite is open for 7 days; one open invite per funder and contact.
create table billing.funder_invite (
  id               uuid primary key,
  idempotency_key  text not null unique,
  funder_party_id  uuid not null,
  member_name      text not null check (char_length(member_name) between 1 and 80),
  contact_kind     text not null check (contact_kind in ('phone', 'email')),
  contact          text not null,
  plan_code        text not null,
  plan_version     int not null,
  token_hash       text not null unique,
  status           text not null check (status in ('open', 'accepted', 'expired', 'cancelled')),
  expires_at       timestamptz not null,
  sent_count       int not null default 1,
  last_sent_at     timestamptz not null,
  member_party_id  uuid,
  membership_id    uuid,
  decided_at       timestamptz,
  created_at       timestamptz not null,
  foreign key (plan_code, plan_version) references billing.plan_version (plan_code, version)
);
create index on billing.funder_invite (funder_party_id, created_at desc);
create unique index funder_invite_one_open on billing.funder_invite (funder_party_id, contact) where status = 'open';

grant select, insert, update on billing.funder_invite to club_app;
