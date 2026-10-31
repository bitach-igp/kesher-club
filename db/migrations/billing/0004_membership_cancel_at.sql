-- T-0310 cancelling a membership (REQ-BIL-004): the funder cancels at the end of the paid period, and the member keeps
-- the money loaded. Until that date the membership stays active and reads "ends on"; `cancel_at` is the date the
-- billing vendor answered. A nullable column with no default: no table rewrite, and every existing row is not
-- cancelling. club_app already updates billing.membership.
alter table billing.membership add column cancel_at timestamptz;
