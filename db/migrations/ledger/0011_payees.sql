-- T-0510 payees for ILS payouts (REQ-PO-001, REQ-PO-002)
-- A payee is a bank account a member has paid, or is about to pay, by payout. The IBAN is the rail's
-- routing identifier (not card data) and is kept so the cooling-off rule can tell a new payee from a
-- known one; first_settled_at marks the first payout that reached it. The payout itself is a transfer
-- of kind 'payout' with its journal; the vendor's payout id lives in ops.external_ref.
create table ops.payee (
  id                 uuid primary key,
  party_id           uuid not null,
  iban               text not null,
  iban_last4         text not null,
  name               text not null,                  -- the account holder as the bank knows them
  bank_code          text,
  validated_at       timestamptz not null,
  first_settled_at   timestamptz,
  created_at         timestamptz not null,
  unique (party_id, iban)
);
create index on ops.payee (party_id, created_at desc);

grant select, insert, update on ops.payee to club_app;
