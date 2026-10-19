Task: T-0023 · Branch: claude/practical-babbage-80xevv · Needs: docker
Why: Migration ledger/0015 adds `ops.job_run`, where the worker records each nightly run (job, Israel run date) so a restart the same day does not run it again. The cloud session only has PGlite, so the real Postgres 16 apply, the re-run, the grants and the constraints go on the PC. Each statement whose success another depends on is in its own `-c` call. Nothing here is a real member or secret.
Steps (from repo root, PowerShell on Windows unless stated):
1. docker run --name kesher-pg -e POSTGRES_PASSWORD=postgres -e POSTGRES_DB=club -p 5433:5432 -d postgres:16
2. Start-Sleep -Seconds 8
3. Get-Content -Raw db/roles.sql | docker exec -i kesher-pg psql -U postgres -d club -v ON_ERROR_STOP=1
4. node db/migrate.mjs --docker --url "postgres://postgres:postgres@localhost:5433/club?sslmode=disable"
5. node db/migrate.mjs --docker --url "postgres://postgres:postgres@localhost:5433/club?sslmode=disable"
6. docker exec -i kesher-pg psql -U postgres -d club -c "\d ops.job_run"
7. docker exec -i kesher-pg psql -U postgres -d club -c "set role club_app; insert into ops.job_run (job, run_date, started_at, finished_at) values ('balance-proof', '2026-10-20', '2026-10-19T23:30:00Z', '2026-10-19T23:31:00Z')"
8. docker exec -i kesher-pg psql -U postgres -d club -c "set role club_app; insert into ops.job_run (job, run_date, started_at, finished_at) values ('balance-proof', '2026-10-20', '2026-10-20T08:00:00Z', '2026-10-20T08:01:00Z')"
9. docker exec -i kesher-pg psql -U postgres -d club -c "set role club_app; insert into ops.job_run (job, run_date, started_at, finished_at) values ('balance-proof', '2026-10-20', '2026-10-20T08:00:00Z', '2026-10-20T08:01:00Z') on conflict do nothing"
10. docker exec -i kesher-pg psql -U postgres -d club -c "set role club_app; insert into ops.job_run (job, run_date, started_at, finished_at) values ('catalogue-sync', '2026-10-20', '2026-10-20T01:00:00Z', '2026-10-20T00:59:00Z')"
11. docker exec -i kesher-pg psql -U postgres -d club -c "set role club_app; update ops.job_run set finished_at = now() where job = 'balance-proof'"
12. docker rm -f kesher-pg
Expected: step 4 prints `ok` for every schema, with ledger at 15 migrations. Step 5 reports no pending migrations. Step 6 shows job, run_date, started_at and finished_at, all not null, with the primary key on (job, run_date). Step 7 prints `INSERT 0 1`. Step 8 fails with a duplicate key violation on `job_run_pkey` (one run per job and day). Step 9 prints `INSERT 0 0`, the worker's own write. Step 10 fails with a check constraint violation (finished before started). Step 11 fails with `permission denied for table job_run` (insert-only for the service role).
Report back: the console output of steps 4, 5, 6, 8, 9, 10 and 11.
