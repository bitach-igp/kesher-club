-- Database roles (T-0005). Run once per database as a superuser, before any migration.
-- Passwords are set out of band from Secrets Manager (`alter role … password …`), never committed.
--
--   club_migrator  owns every schema and runs Atlas. Used only by the release job and local dev.
--   club_app       the service role. SELECT/INSERT on ledger.*, never UPDATE/DELETE (constitution art. 3).
--   club_readonly  read replica / Metabase. SELECT only, no PII columns (views are granted per schema).
--   club_jit       the authorisation path. SELECT on ledger and cards, INSERT on ledger (holds) only.
do $$ begin
  if not exists (select from pg_roles where rolname = 'club_migrator') then
    create role club_migrator login createdb;
  end if;
  if not exists (select from pg_roles where rolname = 'club_app') then
    create role club_app login connection limit 200;
  end if;
  if not exists (select from pg_roles where rolname = 'club_readonly') then
    create role club_readonly login connection limit 20;
  end if;
  if not exists (select from pg_roles where rolname = 'club_jit') then
    create role club_jit login connection limit 100;
  end if;
end $$;

-- Nothing is granted to PUBLIC. Each migration grants what its schema needs to club_app and club_jit.
do $$ begin execute format('revoke all on database %I from public', current_database()); end $$;
revoke all on schema public from public;

-- club_migrator owns what it creates; objects it creates default to no grants for anyone else.
alter role club_migrator set search_path = public;
alter default privileges for role club_migrator revoke all on tables from public;

-- Statement budget for the service roles (fail secure: a runaway query is cut, not queued).
alter role club_app set statement_timeout = '5s';
alter role club_app set idle_in_transaction_session_timeout = '10s';
alter role club_jit set statement_timeout = '200ms';
alter role club_jit set lock_timeout = '50ms';          -- JIT (T-0403): a blocked row is a decline, never a wait past the budget
alter role club_readonly set statement_timeout = '60s';
alter role club_readonly set default_transaction_read_only = on;
