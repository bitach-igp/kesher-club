-- T-0515 cross-currency sends (REQ-PAY-006)
-- A send paid from one purse and received in the other currency is priced once, when the transfer is
-- created, at the club rate then in force (ADR-007); a replay, the sweep or the hold's release two hours
-- later moves exactly that amount and never re-prices. So the transfer itself carries the received leg
-- and the rate it was priced at. All five are null for a same-currency transfer; a converted one has the
-- received amount, its currency, the rate row and the rate applied (received-currency units per one unit
-- sent × 1e6, in the direction used, so the gross and the markup follow from the row alone) together; the
-- check holds every existing row, so it goes on NOT VALID and skips the scan. The markup is the
-- recipient's plan markup in basis points.
alter table ops.transfer add column received_minor bigint;
alter table ops.transfer add column received_currency ledger.currency;
alter table ops.transfer add column fx_rate_id uuid;
alter table ops.transfer add column fx_rate_version int;
alter table ops.transfer add column fx_rate_scaled bigint;
alter table ops.transfer add column fx_markup_bps int;
alter table ops.transfer add constraint transfer_received_check check (
  (received_minor is null and received_currency is null and fx_rate_id is null and fx_rate_version is null and fx_rate_scaled is null and fx_markup_bps is null)
  or (received_minor > 0 and received_currency is not null and received_currency <> currency and fx_rate_id is not null and fx_rate_version is not null and fx_rate_scaled > 0 and fx_markup_bps >= 0)
) not valid;
alter table ops.transfer add constraint transfer_fx_rate_fk foreign key (fx_rate_id) references ops.fx_rate(id) not valid;
