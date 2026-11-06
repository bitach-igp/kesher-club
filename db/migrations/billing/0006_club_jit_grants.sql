-- T-0064 (REQ-CRD-003): what a card authorisation reads and writes in billing (the owner-approved list in specs/tasks/T-0064.md): the member's
-- membership and plan version, and the plan's card-spend entitlement counter and its idempotency record.
grant usage on schema billing to club_jit;
grant select on billing.membership, billing.plan_version to club_jit;
grant select, insert, update on billing.entitlement_usage to club_jit;
grant select, insert on billing.entitlement_consumption to club_jit;
