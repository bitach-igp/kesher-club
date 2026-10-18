-- T-0606 fee payments are transfers; monitoring case lookups (REQ-INS-006, REQ-CMP-001)
-- A member paying an institution's fee item is a money movement like any other, so it gets an
-- ops.transfer row of kind 'fee' and shows in the purse's activity and in transaction monitoring.
-- The kind check was written inline in ledger/0003, so Postgres named it transfer_kind_check.
-- NOT VALID still checks every new and updated row; it only skips the scan of existing rows, every
-- one of which already satisfied the stricter list this replaces.
alter table ops.transfer drop constraint transfer_kind_check;
alter table ops.transfer add constraint transfer_kind_check check (kind in ('p2p','load','payout','fx','allowance','addon','refund','fee')) not valid;

-- The monitoring job asks "is there a case for this party and rule" and "does a case already cover
-- these transfers" on every finding; both filter monitoring cases by the party in the payload.
create index case_monitoring_party_idx on ops.case (kind, (payload->>'partyId')) where kind in ('structuring', 'velocity');
