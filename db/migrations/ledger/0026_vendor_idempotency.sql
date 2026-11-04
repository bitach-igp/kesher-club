-- T-0659 vendor idempotency ledger (REQ-INS-022, REQ-INS-025): what a vendor adapter answered for a key, so a retry after a
-- restart reaches the same object instead of creating a second organization or payment. One row per (provider, key); first
-- write wins and nothing is updated or deleted, so club_app gets select and insert only. `body_hash` is the SHA-256 of the
-- request, never the request (it holds names, emails and an EIN); `result` is the port's own answer, which carries the
-- provider's opaque refs and is read back only by the adapter that wrote it. Provider ids of domain objects still map through
-- ops.external_ref.
create table ops.vendor_idempotency (
  provider    text not null check (length(provider) between 1 and 64),
  key         text not null check (length(key) between 1 and 512),
  body_hash   text not null,
  result      jsonb,
  created_at  timestamptz not null,
  primary key (provider, key)
);

grant select, insert on ops.vendor_idempotency to club_app;
