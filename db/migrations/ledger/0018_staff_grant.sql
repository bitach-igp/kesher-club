-- T-0924 institution staff grants (REQ-ADM-004): granting an institution's finance or admin role goes
-- through ops.approval_request as kind 'staff_grant', needing a second, different admin. The kind check is
-- dropped and re-added as a superset of 0013's list; NOT VALID skips only the scan of existing rows, all of
-- which satisfy the wider list.
-- The drop is re-added as a superset by the next statement in the same transaction; pre-launch, no live rows.
-- squawk-ignore ban-drop-constraint
alter table ops.approval_request drop constraint approval_request_kind_check;
alter table ops.approval_request add constraint approval_request_kind_check check (kind in ('allowance_run','payout','flag_flip','provider_binding','ledger_correction','fx_rate','staff_grant')) not valid;
