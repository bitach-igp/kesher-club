-- T-0650 US banking for an institution (REQ-INS-022): an institution's US account at the banking provider, held by its
-- own US entity or by the platform's company with the institution under it. Insert-only: the current status is the
-- latest row (by seq, never by time or id), and a rejection followed by a new application is a new row. Provider ids
-- (the entity or sub-account) live in ops.external_ref, never here.
create table org.institution_us_banking_event (
  id                      uuid primary key,
  seq                     bigint generated always as identity unique,
  institution_id          uuid not null references org.institution(id),
  holder                  text not null check (holder in ('platform', 'institution')),
  status                  text not null check (status in ('pending', 'needs_info', 'approved', 'rejected')),
  provider_status         text,
  -- A platform institution whose provider keeps one pooled account has no account number of its own.
  shares_platform_account boolean not null default false,
  -- The link request that appended this row; null when the provider's own event or a status poll did.
  idempotency_key         text,
  at                      timestamptz not null
);
create index on org.institution_us_banking_event (institution_id, seq desc);

-- The banking adapter's idempotency ledger (T-0648): key -> the request's SHA-256 and the result it answered, so a retry
-- after a restart reaches the same object instead of creating a second one. First write wins; nothing is updated.
create table org.us_banking_key (
  key         text primary key,
  body_hash   text not null,
  result      jsonb,
  created_at  timestamptz not null
);

grant select, insert on org.institution_us_banking_event, org.us_banking_key to club_app;
