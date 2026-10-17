Task: T-0012 · Branch: claude/practical-babbage-80xevv · Needs: docker
Why: Migration 0005 moves the balance cache to ops.account_balance and drops it from ledger; the cloud session only has PGlite, so the real Postgres 16 apply, the grant check and the re-run go on the PC.
Steps (from repo root, PowerShell on Windows unless stated):
1. docker run --name kesher-pg -e POSTGRES_PASSWORD=postgres -e POSTGRES_DB=club -p 5433:5432 -d postgres:16
2. Start-Sleep -Seconds 8
3. Get-Content -Raw db/roles.sql | docker exec -i kesher-pg psql -U postgres -d club -v ON_ERROR_STOP=1
4. node db/migrate.mjs --docker --url "postgres://postgres:postgres@localhost:5433/club?sslmode=disable"
5. node db/migrate.mjs --docker --url "postgres://postgres:postgres@localhost:5433/club?sslmode=disable"
6. docker exec -i kesher-pg psql -U postgres -d club -c "select schemaname, count(*) as tables from pg_tables where schemaname in ('ledger','ops','agent','billing','legal','org','addons','notify','audit') group by 1 order by 1"
7. docker exec -i kesher-pg psql -U postgres -d club -c "\dp ledger.*"
8. docker exec -i kesher-pg psql -U postgres -d club -c "\dp ops.account_balance"
9. docker exec -i kesher-pg psql -U postgres -d club -c "select grantee, table_schema, table_name, privilege_type from information_schema.role_table_grants where grantee = 'club_app' and table_schema = 'ledger' and privilege_type in ('UPDATE','DELETE','TRUNCATE')"
10. docker rm -f kesher-pg
Expected: step 4 prints `ok   ledger` (5 migrations) then org, billing, legal, addons, notify, audit, agent. Step 5 reports no pending migrations for every schema. Step 6 shows ledger with 3 tables (journal, posting, account) and ops with 11 (account_balance added). Step 7 shows club_app with only `r` and `a` (select, insert) on every ledger table. Step 8 shows club_app with `arw` on ops.account_balance. Step 9 returns 0 rows.
Report back: the console output of steps 4, 6, 7, 8 and 9.
