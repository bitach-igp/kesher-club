-- T-1104 recipient invite (REQ-PAY-001); enabling for phase 1 gap 4b
-- A member who wants to pay someone with no account asks us to text them. An invite is a request to a phone, never
-- money: no journal, hold or transfer references it, and the table has no amount that moves (the hint is only the
-- sender's note of what they mean to send). The invitee's phone is personal data (class P1): the table keeps its
-- blind index (HMAC-SHA256, T-0024) to find it again and a sealed copy to open it for the one text and for the lazy
-- check that a number now belongs to a verified member; the sealed copy is cleared when the invite ends. Never a
-- plain phone, never in a log.
-- State machine: open -> claimable (the invitee joined and passed T1) -> claimed (the sender took the recipient to the
-- ordinary send); open or claimable -> expired (14 days, as REQ-PAY-004 requests). Each state is entered once, enforced
-- by the history table's unique (invite_id, to_status). ops.* is not insert-only, so the invite row carries a status the
-- app may change (column-level update grant: who, which phone and the hint can never change), and every change also
-- inserts a history row that club_app can never update or delete.
create table ops.recipient_invite (
  id                    uuid primary key,
  sender_party_id       uuid not null,
  phone_index           bytea not null check (octet_length(phone_index) = 32),
  phone_sealed          bytea,
  amount_hint_minor     bigint check (amount_hint_minor > 0),
  amount_hint_currency  ledger.currency,
  category              text check (category in ('soldier','lone_soldier','yeshiva_student','seminary_student','university_student','rabbi','volunteer','program_participant','other')),
  status                text not null default 'open' check (status in ('open','claimable','claimed','expired')),
  recipient_party_id    uuid,
  sender_told_at        timestamptz,        -- the sender's 'they joined' notice went out; null while it is still owed
  reconciled_at         timestamptz,        -- when an open invite's number was last checked against the members (bounds the lazy check)
  created_at            timestamptz not null,
  expires_at            timestamptz not null,
  updated_at            timestamptz not null,
  check ((amount_hint_minor is null) = (amount_hint_currency is null)),
  check (status not in ('claimable','claimed') or recipient_party_id is not null),
  check (phone_sealed is not null or status in ('claimed','expired')),
  check (expires_at > created_at)
);
-- One live invite per sender and phone: the same sender inviting the same number again finds this one.
create unique index recipient_invite_live on ops.recipient_invite (sender_party_id, phone_index) where status in ('open','claimable');
-- The join hook: which open invites does this phone have.
create index on ops.recipient_invite (phone_index) where status = 'open';
create index on ops.recipient_invite (sender_party_id, created_at desc);
create index on ops.recipient_invite (expires_at) where status in ('open','claimable');

create table ops.recipient_invite_event (
  id              bigint generated always as identity primary key,
  invite_id       uuid not null references ops.recipient_invite (id),
  from_status     text check (from_status in ('open','claimable','claimed','expired')),
  to_status       text not null check (to_status in ('open','claimable','claimed','expired')),
  actor_party_id  uuid,
  at              timestamptz not null,
  unique (invite_id, to_status)
);

grant select, insert on ops.recipient_invite to club_app;
grant update (status, recipient_party_id, phone_sealed, updated_at, sender_told_at, reconciled_at) on ops.recipient_invite to club_app;
grant select, insert on ops.recipient_invite_event to club_app;
