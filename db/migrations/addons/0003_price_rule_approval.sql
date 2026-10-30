-- T-0928 add-on price rules from the admin API (REQ-MKT-002, REQ-ADM-003): Kesher finance proposes a rule, a
-- second finance member approves it, and only then is it active. A proposal is a row with active = false; the
-- columns below say who proposed it, why, which approval decides it, and whether it was rejected. Rules written
-- before this have none of them. The app may now write rules; it still never deletes one.
alter table addons.price_rule add column proposed_by text;
alter table addons.price_rule add column reason text;
alter table addons.price_rule add column approval_id uuid;
alter table addons.price_rule add column rejected_at timestamptz;
alter table addons.price_rule add column activated_at timestamptz;

grant insert, update on addons.price_rule to club_app;
