Task: T-0503 · Branch: claude/practical-babbage-80xevv · Needs: docker
Why: Migration ledger/0008 creates ops.auto_reload (one rule per purse, referencing ledger.account and ops.transfer); the cloud session only has PGlite, so the real Postgres 16 apply, the constraint checks and the re-run go on the PC.
Steps (from repo root, PowerShell on Windows unless stated):
1. docker run --name kesher-pg -e POSTGRES_PASSWORD=postgres -e POSTGRES_DB=club -p 5433:5432 -d postgres:16
2. Start-Sleep -Seconds 8
3. Get-Content -Raw db/roles.sql | docker exec -i kesher-pg psql -U postgres -d club -v ON_ERROR_STOP=1
4. node db/migrate.mjs --docker --url "postgres://postgres:postgres@localhost:5433/club?sslmode=disable"
5. node db/migrate.mjs --docker --url "postgres://postgres:postgres@localhost:5433/club?sslmode=disable"
6. docker exec -i kesher-pg psql -U postgres -d club -c "select schemaname, count(*) as tables from pg_tables where schemaname in ('ledger','ops','agent','billing','legal','org','addons','notify','audit','cards','identity') group by 1 order by 1"
7. docker exec -i kesher-pg psql -U postgres -d club -c "\d ops.auto_reload"
8. docker exec -i kesher-pg psql -U postgres -d club -c "set role club_app; insert into ledger.account (id, owner_party_id, type, currency, normal_side) values ('00000000-0000-7000-8000-00000000a503', '00000000-0000-7000-8000-00000000b503', 'wallet', 'USD', 'C'); insert into ops.auto_reload (id, party_id, account_id, currency, threshold_minor, target_minor, method, payment_method_id) values (gen_random_uuid(), '00000000-0000-7000-8000-00000000b503', '00000000-0000-7000-8000-00000000a503', 'USD', 5000, 5000, 'card', 'pm_handoff')"
9. docker exec -i kesher-pg psql -U postgres -d club -c "set role club_app; insert into ops.auto_reload (id, party_id, account_id, currency, threshold_minor, target_minor, method, payment_method_id) values (gen_random_uuid(), '00000000-0000-7000-8000-00000000b503', '00000000-0000-7000-8000-00000000a503', 'USD', 5000, 20000, 'card', 'pm_handoff') returning enabled, last_attempt_at"
10. docker exec -i kesher-pg psql -U postgres -d club -c "\dp ops.auto_reload"
11. docker rm -f kesher-pg
Expected: step 4 prints `ok   ledger` (8 migrations) then identity, org, billing, legal, addons, notify, audit, agent. Step 5 reports no pending migrations for every schema. Step 6 shows ops with 13 tables (auto_reload added). Step 7 lists ops.auto_reload with the threshold, target and method checks, a unique index on account_id, the party_id index and the partial last_attempt_at index. Step 8 fails with a check constraint violation on auto_reload_check (target must exceed threshold). Step 9 returns one row with enabled = t and an empty last_attempt_at. Step 10 shows club_app with `arw` on ops.auto_reload.
Report back: the console output of steps 4, 6, 7, 8, 9 and 10.

## Result
Date: 2026-10-18 10:30 Asia/Jerusalem (desktop checker, on Zvi's request)
Outcome: PASS (step 9 needed the account insert split out; see below)
Ran at f1fe214 in one postgres:16 container shared by T-0503/T-0505/T-0507/T-0510 (steps 1-5 are identical; steps 1-5 run once, then each card's checks).
- Step 3 roles.sql: DO, DO, REVOKE, ALTER ROLE x7, ALTER DEFAULT PRIVILEGES.
- Step 4: ledger "Migrating to version 0011 (11 migrations in total)" ... "-- 11 migrations / 79 sql statements", then `ok   ledger`, `ok   identity`, `ok   org`, `ok   billing`, `ok   legal`, `ok   addons`, `ok   notify`, `ok   audit`, `ok   agent` (rc=0).
- Step 5 re-run: "No migration files to execute" x9, all ok (rc=0).
- Step 6: addons 4, agent 4, audit 1, billing 5, cards 2, identity 1, ledger 3, legal 2, notify 3, ops 17, org 12. ops is 17, not the 13 the request expected: 0009-0011 (risk_limit, risk_tier, payment_request, payee) are on the branch too, so 13 + 4 = 17.
- Step 7: ops.auto_reload has checks auto_reload_check (target_minor > threshold_minor), auto_reload_method_check, auto_reload_threshold_minor_check; UNIQUE auto_reload_account_id_key (account_id); auto_reload_party_id_idx; partial auto_reload_last_attempt_at_idx WHERE enabled; FKs to ledger.account and ops.transfer. As expected.
- Step 8: `INSERT 0 1` then `ERROR: new row for relation "auto_reload" violates check constraint "auto_reload_check"`. As expected.
- Step 9 as written: `ERROR: ... violates foreign key constraint "auto_reload_account_id_fkey" ... Key (account_id)=(...a503) is not present in table "account"`. Cause: the request's own script. psql -c runs both step 8 statements in one implicit transaction, so the failing insert rolls back the ledger.account insert too. That is a problem in the step text, not in the migration.
  Re-checked with the account inserted in its own psql -c, then step 9 unchanged: one row, `enabled = t`, `last_attempt_at` empty. As expected.
  Fix for future requests: put the account insert in its own -c, or run step 9 in the same session as a separate statement.
- Step 10: `club_app=arw/postgres` on ops.auto_reload. As expected.
