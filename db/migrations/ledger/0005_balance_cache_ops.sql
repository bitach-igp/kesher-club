-- T-0012 balance cache moves from ledger to ops (enabling)
-- ledger.* is insert-only for every service role (constitution art. 3). The balance cache is the one
-- table post() updates in place, so it lives in ops from now on: same columns, same FK, rebuilt from
-- postings by the proof job (RUN-08). Pre-launch, no live data: the old table is dropped in the same
-- migration instead of the two-release expand/contract dance.
create table ops.account_balance (
  account_id      uuid primary key references ledger.account(id),
  balance_minor   bigint not null default 0,
  last_posting_id bigint not null default 0,
  version         bigint not null default 0
);

insert into ops.account_balance (account_id, balance_minor, last_posting_id, version)
select account_id, balance_minor, last_posting_id, version from ledger.account_balance;

-- squawk-ignore ban-drop-table
drop table ledger.account_balance;

-- ops.* already carries select, insert, update for club_app (0001); restate it for the new table so
-- the grant is explicit, and make sure nothing in ledger.* can be updated by the app role again.
grant select, insert, update on ops.account_balance to club_app;
revoke update, delete, truncate on all tables in schema ledger from club_app;
