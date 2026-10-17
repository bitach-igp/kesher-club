-- T-0603 institutions: roster imports, invites, staff, consent grants and row-level security (REQ-INS-001, REQ-INS-002, REQ-INS-005)
create schema if not exists org;

create table org.institution (
  id          uuid primary key,
  name        text not null,
  market      text not null check (market in ('US','IL')),
  created_at  timestamptz not null default now()
);

-- Staff accounts come from the OrgIdPPort (SSO + SCIM); roles: admin | finance | staff.
create table org.staff (
  party_id        uuid primary key,
  institution_id  uuid not null references org.institution(id),
  role            text not null check (role in ('admin','finance','staff')),
  active          boolean not null default true,
  created_at      timestamptz not null default now()
);
create index on org.staff (institution_id);

-- A roster import is validated as a whole; rows are stored for the report and committed all or nothing.
create table org.roster_import (
  id               uuid primary key,
  idempotency_key  text not null unique,
  institution_id   uuid not null references org.institution(id),
  status           text not null check (status in ('validated','rejected','committed')),
  row_count        int not null,
  error_count      int not null,
  mapping          jsonb not null,
  created_by       uuid not null,
  created_at       timestamptz not null default now(),
  committed_at     timestamptz
);
create index on org.roster_import (institution_id, created_at desc);

create table org.roster_row (
  import_id     uuid not null references org.roster_import(id),
  row_number    int not null,
  member_name   text not null,
  member_phone  text,
  funder_email  text,
  funder_phone  text,
  programme     text,
  errors        jsonb not null default '[]',        -- [{ column, message }]
  primary key (import_id, row_number)
);

-- One member per institution per roster row; the party ids fill in as the family verifies and activates.
create table org.member (
  id               uuid primary key,
  institution_id   uuid not null references org.institution(id),
  import_id        uuid references org.roster_import(id),
  row_number       int,
  member_name      text not null,
  member_party_id  uuid,
  funder_party_id  uuid,
  programme        text,
  status           text not null default 'invited' check (status in ('invited','verified','active','declined','removed')),
  created_at       timestamptz not null default now(),
  updated_at       timestamptz not null default now(),
  unique (import_id, row_number)
);
create index on org.member (institution_id, status);
create index on org.member (member_party_id);

create table org.invite (
  id              uuid primary key,
  idempotency_key text not null unique,
  member_id       uuid not null references org.member(id),
  channel         text not null check (channel in ('email','sms')),
  recipient_hash  text not null,                     -- sha256 of the address; the address itself is only in the message
  token_hash      text not null unique,
  status          text not null default 'sent' check (status in ('sent','opened','accepted','expired','bounced')),
  sent_at         timestamptz not null,
  expires_at      timestamptz not null,
  accepted_at     timestamptz
);
create index on org.invite (member_id);

-- REQ-INS-005: a member grants staff visibility into merchant-level spend; without it staff see only the balance band and fees owed.
create table org.consent_grant (
  member_party_id  uuid not null,
  institution_id   uuid not null references org.institution(id),
  scope            text not null check (scope in ('spend_detail')),
  granted_at       timestamptz not null,
  revoked_at       timestamptz,
  primary key (member_party_id, institution_id, scope)
);

-- Fees owed to the institution (collections, REQ-INS-006 later); visible to staff regardless of consent.
create table org.fee_item (
  id               uuid primary key,
  institution_id   uuid not null references org.institution(id),
  member_party_id  uuid not null,
  description      text not null,
  amount_minor     bigint not null check (amount_minor > 0),
  currency         ledger.currency not null,
  status           text not null default 'due' check (status in ('due','paid','waived')),
  due_at           date not null,
  created_at       timestamptz not null default now()
);
create index on org.fee_item (institution_id, member_party_id, status);

-- Merchant-level spend as staff would see it (fed from card transactions). RLS gates this table.
create table org.member_spend (
  id               uuid primary key,
  institution_id   uuid not null references org.institution(id),
  member_party_id  uuid not null,
  merchant_name    text not null,                    -- untrusted text
  mcc              text not null,
  amount_minor     bigint not null,
  currency         ledger.currency not null,
  at               timestamptz not null
);
create index on org.member_spend (institution_id, member_party_id, at desc);

-- Row-level security. The API sets app.staff_party_id and app.institution_id per request (set_config … true).
alter table org.member_spend enable row level security;
alter table org.member_spend force row level security;
create policy member_spend_with_consent on org.member_spend for select to club_app
  using (
    institution_id = nullif(current_setting('app.institution_id', true), '')::uuid
    and exists (
      select 1 from org.consent_grant g
       where g.member_party_id = org.member_spend.member_party_id
         and g.institution_id = org.member_spend.institution_id
         and g.scope = 'spend_detail'
         and g.revoked_at is null
    )
  );
-- The member's own app session may always see its own rows.
create policy member_spend_self on org.member_spend for select to club_app
  using (member_party_id = nullif(current_setting('app.party_id', true), '')::uuid);
create policy member_spend_insert on org.member_spend for insert to club_app with check (true);

-- What staff always get: a balance band (never the exact balance) and fees owed.
create or replace function org.balance_band(available_minor bigint) returns text language sql immutable as $$
  select case
    when available_minor < 0 then 'overdrawn'
    when available_minor < 10000 then 'low'       -- under $100 / ₪100
    when available_minor < 50000 then 'ok'
    else 'healthy' end
$$;

grant usage on schema org to club_app;
grant select, insert, update on org.institution, org.staff, org.roster_import, org.member, org.invite, org.consent_grant, org.fee_item to club_app;
grant select, insert on org.roster_row, org.member_spend to club_app;
grant execute on function org.balance_band(bigint) to club_app;
