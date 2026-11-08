-- T-0065 legal documents (enabling): a new legal text takes two admins through ops.approval_request. The kind check gains
-- 'legal_publish': dropped and re-added as a superset of 0025's list; NOT VALID skips only the scan of existing rows, all
-- of which satisfy the wider list.
-- The drop is re-added as a superset by the next statement in the same transaction; pre-launch, no live rows.
-- squawk-ignore ban-drop-constraint
alter table ops.approval_request drop constraint approval_request_kind_check;
alter table ops.approval_request add constraint approval_request_kind_check check (kind in ('allowance_run','payout','flag_flip','provider_binding','ledger_correction','fx_rate','staff_grant','institution_deposit','credit_limit','kyb_decision','price_rule','plan_version','legal_publish')) not valid;
