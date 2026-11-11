-- T-0558 load sweep marker (REQ-WAL-003, REQ-LED-004): when the vendor was last asked about a load held for the bank's hold days,
-- so the sweep reads a held load once per interval instead of every cycle (vendor cost). One row per transfer, upserted.
-- ops.* is not insert-only: club_app gets select, insert and update (no delete). The vendor's own load id stays in ops.external_ref.
create table ops.load_check (
  transfer_id uuid primary key references ops.transfer (id),
  last_asked_at timestamptz not null
);
grant select, insert, update on ops.load_check to club_app;
