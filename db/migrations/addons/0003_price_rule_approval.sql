-- T-0928 add-on price rules from the admin API (REQ-MKT-002, REQ-ADM-003): Kesher finance proposes a rule, a
-- second finance member approves it, and only then is it active. A proposal is a row with active = false; the
-- columns below say who proposed it, why, which approval decides it, and whether it was rejected. Rules written
-- before this have none of them. The app may now insert a rule and move its state; it may not change a rule's
-- pricing terms once written (only the state columns are granted), and it never deletes one.
alter table addons.price_rule add column proposed_by text;
alter table addons.price_rule add column reason text;
alter table addons.price_rule add column approval_id uuid;
alter table addons.price_rule add column rejected_at timestamptz;
alter table addons.price_rule add column activated_at timestamptz;

grant insert on addons.price_rule to club_app;
grant update (active, approval_id, activated_at, rejected_at) on addons.price_rule to club_app;
