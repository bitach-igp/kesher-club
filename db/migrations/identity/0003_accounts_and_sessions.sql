-- T-0119 identity in Postgres (REQ-AUTH-001, REQ-AUTH-007)
-- Members, their OTP starts and sessions, passkeys, devices, refresh-token families and recovery
-- restrictions, until now held in process memory. PII is sealed at field level (T-0024, constitution
-- art. 9): the phone, a passkey's device name and a device's push token are bytea written by the app's
-- PII cipher, never plaintext. The phone is found, and kept unique, through its blind index. Tokens are
-- stored only as SHA-256 hashes. An OTP start keeps no provider id and no phone, only the phone's index,
-- because counting starts per phone is all it is for.
create type identity.user_status as enum ('pending', 'active', 'restricted', 'closed');

create table identity.user_account (
  party_id     uuid primary key,
  phone_index  bytea not null unique,                 -- HMAC blind index of the E.164 phone
  phone_sealed bytea not null,                        -- the phone, sealed
  status       identity.user_status not null,
  roles        text[] not null default '{}',
  created_at   timestamptz not null
);

create table identity.otp_start (
  id          bigint generated always as identity primary key,
  phone_index bytea not null,
  started_at  timestamptz not null
);
create index on identity.otp_start (phone_index, started_at);

create table identity.otp_session (
  token_hash   text primary key,                      -- SHA-256 of the session token, base64url
  phone_sealed bytea not null,
  purpose      text not null check (purpose in ('register', 'recovery')),
  expires_at   timestamptz not null,
  consumed_at  timestamptz
);

create table identity.passkey (
  credential_id      text primary key,
  party_id           uuid not null,
  public_key         text not null,
  counter            bigint not null check (counter >= 0),
  device_id          text not null,
  device_name_sealed bytea not null,                  -- member-chosen, may carry a name
  created_at         timestamptz not null,
  last_used_at       timestamptz
);
create index on identity.passkey (party_id);

create table identity.device (
  party_id          uuid not null,
  device_id         text not null,
  first_seen_at     timestamptz not null,
  last_seen_at      timestamptz not null,
  push_token_sealed bytea,
  primary key (party_id, device_id)
);

-- One refresh-token family per device session (REQ-AUTH-007). The current hash is unique; hashes
-- rotated out live in their own table so presenting one is an indexed lookup that revokes the family.
create table identity.session (
  session_id           uuid primary key,
  party_id             uuid not null,
  device_id            text not null,
  roles                text[] not null default '{}',
  current_refresh_hash text not null unique,
  created_at           timestamptz not null,
  refresh_expires_at   timestamptz not null,
  revoked_at           timestamptz,
  revoked_reason       text
);
create index on identity.session (party_id);

create table identity.session_rotated_hash (
  refresh_hash text primary key,
  session_id   uuid not null references identity.session (session_id),
  rotated_at   timestamptz not null default clock_timestamp()   -- per statement, so rotations keep their order
);
create index on identity.session_rotated_hash (session_id);

create table identity.restriction (
  party_id   uuid primary key,
  until      timestamptz not null,
  reason     text not null check (reason in ('otp_recovery')),
  created_at timestamptz not null default now()
);

grant select, insert, update on identity.user_account, identity.otp_session, identity.device, identity.session, identity.restriction to club_app;
grant select, insert on identity.otp_start, identity.session_rotated_hash to club_app;
-- removePasskeys (recovery replaces every passkey): the one delete the service needs.
grant select, insert, update, delete on identity.passkey to club_app;
