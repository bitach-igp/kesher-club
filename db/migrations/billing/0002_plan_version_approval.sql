-- T-0932 plan versions (REQ-ADM-006): finance proposes a version, a second finance member approves it, and only
-- an active version is offered. Existing versions were created active, so `state` defaults to 'active' (a constant
-- default: no table rewrite) and the check holds for every row already there (NOT VALID skips only the scan).
-- The price, term, entitlements and markup stay immutable: club_app may set only the decision columns.
alter table billing.plan_version add column state text not null default 'active';
alter table billing.plan_version add constraint plan_version_state_check check (state in ('proposed', 'active', 'rejected')) not valid;
alter table billing.plan_version add column market text;
alter table billing.plan_version add constraint plan_version_market_check check (market in ('IL', 'US')) not valid;
alter table billing.plan_version add column approval_id uuid;
alter table billing.plan_version add column proposed_by text;
alter table billing.plan_version add column reason text;
alter table billing.plan_version add column decided_at timestamptz;

grant insert on billing.plan, billing.plan_version to club_app;
grant update (state, approval_id, decided_at) on billing.plan_version to club_app;
