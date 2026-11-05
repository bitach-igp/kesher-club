-- T-0555 (REQ-PO-001, REQ-INS-006, REQ-INS-017, REQ-INS-021): an institution's money that is set aside for a payout waiting on
-- its approver lives in its own `payout_reserve` account, still the institution's own money. A new enum value cannot be used in the
-- transaction that adds it, so this file does nothing else; nothing posts to the account until the payout workflow (T-0550) does.
-- The ledger stays insert-only: no grant changes.
-- Account types are never compared by their order, so appending the value is fine.
-- squawk-ignore require-enum-value-ordering
alter type ledger.account_type add value 'payout_reserve';
