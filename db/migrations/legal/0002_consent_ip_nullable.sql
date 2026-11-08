-- T-0067 legal consent ip is nullable: a consent no longer records an address it does not collect (enabling)
-- T-0061 stored the unspecified address 0.0.0.0 to mean "not collected" because the column was `inet not null`. Dropping the
-- constraint lets a consent record no address at all. Existing rows are left alone (no backfill): a stored 0.0.0.0 still reads back
-- as 0.0.0.0. Dropping NOT NULL needs no table scan. The only reader is LegalService, which now types the column as nullable.
-- squawk-ignore ban-drop-not-null
alter table legal.consent alter column ip drop not null;
