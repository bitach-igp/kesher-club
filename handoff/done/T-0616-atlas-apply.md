Task: T-0616 · Branch: claude/practical-babbage-80xevv · Needs: docker
Why: Migration ledger/0020 adds ops.institution_credit_limit (insert-only for club_app: select and insert, no update or delete; a limit cannot be negative; one row per approval) and widens the ops.approval_request kind check with 'credit_limit' (dropped and re-added NOT VALID). The allowance run takes `pg_advisory_xact_lock(hashtextextended(...))` per institution; step 10 checks that the function is callable as club_app. They need the real Postgres 16 apply; the cloud session only has PGlite. Each statement whose success another depends on is in its own `-c` call. Nothing here is a real institution.
Steps (from repo root, PowerShell on Windows unless stated):
1. docker run --name kesher-pg -e POSTGRES_PASSWORD=postgres -e POSTGRES_DB=club -p 5433:5432 -d postgres:16
2. Start-Sleep -Seconds 8
3. Get-Content -Raw db/roles.sql | docker exec -i kesher-pg psql -U postgres -d club -v ON_ERROR_STOP=1
4. node db/migrate.mjs --docker --url "postgres://postgres:postgres@localhost:5433/club?sslmode=disable"
5. node db/migrate.mjs --docker --url "postgres://postgres:postgres@localhost:5433/club?sslmode=disable"
6. docker exec -i kesher-pg psql -U postgres -d club -c "set role club_app; insert into ops.institution_credit_limit (id, institution_id, currency, limit_minor, approval_id, set_at) values ('00000000-0000-7000-8000-000000061601', '00000000-0000-7000-8000-000000061600', 'ILS', 500000, '00000000-0000-7000-8000-000000061611', now())"
7. docker exec -i kesher-pg psql -U postgres -d club -c "set role club_app; insert into ops.institution_credit_limit (id, institution_id, currency, limit_minor, approval_id, set_at) values ('00000000-0000-7000-8000-000000061602', '00000000-0000-7000-8000-000000061600', 'ILS', -1, '00000000-0000-7000-8000-000000061612', now())"
8. docker exec -i kesher-pg psql -U postgres -d club -c "set role club_app; update ops.institution_credit_limit set limit_minor = 900000"
9. docker exec -i kesher-pg psql -U postgres -d club -c "set role club_app; insert into ops.approval_request (id, kind, subject, payload, required, scope, requested_by, status, expires_at, created_at) values ('00000000-0000-7000-8000-000000061603', 'credit_limit', 'credit:t0616', '{}', 2, 'platform', '00000000-0000-7000-8000-000000061609', 'awaiting_second_approval', now() + interval '7 days', now())"
10. docker exec -i kesher-pg psql -U postgres -d club -c "set role club_app; begin; select pg_advisory_xact_lock(hashtextextended('institution-credit:' || '00000000-0000-7000-8000-000000061600', 0)); commit;"
11. docker rm -f kesher-pg
Expected: step 4 prints `ok` for every schema, with ledger at 20 migrations. Step 5 reports no pending migrations. Step 6 prints `INSERT 0 1`. Step 7 fails with a check constraint violation (a negative limit). Step 8 fails with `permission denied for table institution_credit_limit` (limits are never updated, only superseded). Step 9 prints `INSERT 0 1`. Step 10 prints one row with an empty `pg_advisory_xact_lock` and `COMMIT`.
Report back: the console output of steps 4, 5, 6, 7, 8, 9 and 10.

## Result
PASS, 2026-10-20 15:12 Asia/Jerusalem, desktop runner worktree at db71494 (Docker 29.8.2, postgres:16).
- Step 4: `Migrating to version 0020 (20 migrations in total)` for ledger; `ok` for ledger, identity, org, billing, legal, addons, notify, audit, agent. (The first attempt was cut off by the desktop tool's timeout after five schemas; re-running the same command finished the rest and printed `ok` for all nine. atlas_ledger revisions: 20, max 0020.)
- Step 5: `No migration files to execute` for all nine schemas, then `ok` for each.
- Step 6: `INSERT 0 1`.
- Step 7: `ERROR: new row for relation "institution_credit_limit" violates check constraint "institution_credit_limit_limit_minor_check"`.
- Step 8: `ERROR: permission denied for table institution_credit_limit`.
- Step 9: `INSERT 0 1`.
- Step 10: `BEGIN`, one row with an empty `pg_advisory_xact_lock`, `COMMIT`.
- Step 11: container removed.
