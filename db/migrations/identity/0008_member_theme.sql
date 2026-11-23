-- T-1020 appearance preference (REQ-UX-002)
-- The account's appearance on the existing per-member preference row (0002): system follows the device,
-- light and dark pin it. A constant default is a metadata-only add (Postgres 11+), so the not-null needs
-- no backfill and existing rows read 'system'. The check goes on NOT VALID because every existing row
-- already satisfies it; for the first live migration run:
--   alter table identity.member_preference validate constraint member_preference_theme_check;
-- club_app keeps the select, insert and update it was granted in 0002; no new grant.
alter table identity.member_preference add column theme text not null default 'system';
alter table identity.member_preference add constraint member_preference_theme_check check (theme in ('system', 'light', 'dark')) not valid;
