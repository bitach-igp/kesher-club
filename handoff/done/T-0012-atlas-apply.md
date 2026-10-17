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

## Result
PASS — run 2026-10-17 22:05 (Asia/Jerusalem) by the desktop checker on Zvi's PC (Windows, Docker 29.8.2, postgres:16), runner worktree detached at e4f5006.
- Steps 1–3: container up; roles.sql applied (exit 0).
- Step 4: `ok   ledger` … `ok   agent` for all 8 schemas, exit 0. atlas_ledger.atlas_schema_revisions: 0001 init, 0002 ops_cases, 0003 transfers, 0004 approvals, 0005 balance_cache_ops.
- Step 5: "No migration files to execute" / `ok` for every schema, exit 0.
- Step 6: addons 4, agent 4, audit 1, billing 5, ledger 3, legal 2, notify 3, ops 11, org 12.
- Step 7 (`\dp ledger.*`): account, journal, posting each `club_app=ar/postgres`; posting_id_seq default privileges only (identity column, no grant needed).
- Step 8 (`\dp ops.account_balance`): `club_app=arw/postgres`.
- Step 9: 0 rows (no UPDATE/DELETE/TRUNCATE for club_app on ledger.*).
- Step 10: container removed.
