-- T-0503 auto-reload rules (REQ-WAL-004)
-- One rule per purse: below the threshold, the worker loads up to the target through the ordinary
-- LoadWorkflow, at most once per 24 hours. last_attempt_at is the claim: it is stamped before the pull
-- and the load's key derives from it, so a rerun inside the window neither loads twice nor retries a
-- failure. payment_method_id is the vendor's token; card data never exists on our side.
create table ops.auto_reload (
  id                 uuid primary key,
  party_id           uuid not null,
  account_id         uuid not null unique references ledger.account(id),
  currency           ledger.currency not null,
  enabled            boolean not null default true,
  threshold_minor    bigint not null check (threshold_minor >= 0),
  target_minor       bigint not null check (target_minor > threshold_minor),
  method             text not null check (method in ('card','apple_pay','google_pay')),
  payment_method_id  text not null,
  last_attempt_at    timestamptz,                    -- the 24 h window starts here, success or failure
  last_transfer_id   uuid references ops.transfer(id),
  created_at         timestamptz not null default now(),
  updated_at         timestamptz not null default now()
);
create index on ops.auto_reload (party_id);
create index on ops.auto_reload (last_attempt_at) where enabled;

grant select, insert, update on ops.auto_reload to club_app;
