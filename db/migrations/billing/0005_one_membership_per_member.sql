-- T-0313 (REQ-BIL-002, REQ-BIL-003): a member holds one membership that is not cancelled. Until now only the application checked
-- (check-then-act), so two overlapping requests for one member under different keys could each start a recurring charge. The partial
-- unique index makes the database refuse the second. A cancelled membership does not count, so a member can start again after one ends.
-- Pre-launch: billing.membership has no live traffic and Atlas applies each file in a transaction, where a concurrent build is not allowed.
-- squawk-ignore require-concurrent-index-creation
create unique index membership_one_open_per_member on billing.membership (member_party_id) where status <> 'cancelled';
