Task: T-0908 · Branch: claude/practical-babbage-80xevv · Needs: docker
Why: Migration ledger/0006 creates ops.complaint and adds the disposition columns and a NOT VALID check to ops.case; the cloud session only has PGlite, so the real Postgres 16 apply, the constraint check and the re-run go on the PC.
Steps (from repo root, PowerShell on Windows unless stated):
1. docker run --name kesher-pg -e POSTGRES_PASSWORD=postgres -e POSTGRES_DB=club -p 5433:5432 -d postgres:16
2. Start-Sleep -Seconds 8
3. Get-Content -Raw db/roles.sql | docker exec -i kesher-pg psql -U postgres -d club -v ON_ERROR_STOP=1
4. node db/migrate.mjs --docker --url "postgres://postgres:postgres@localhost:5433/club?sslmode=disable"
5. node db/migrate.mjs --docker --url "postgres://postgres:postgres@localhost:5433/club?sslmode=disable"
6. docker exec -i kesher-pg psql -U postgres -d club -c "select schemaname, count(*) as tables from pg_tables where schemaname in ('ledger','ops','agent','billing','legal','org','addons','notify','audit') group by 1 order by 1"
7. docker exec -i kesher-pg psql -U postgres -d club -c "\d ops.complaint"
8. docker exec -i kesher-pg psql -U postgres -d club -c "select conname, convalidated from pg_constraint where conrelid = 'ops.case'::regclass and conname = 'case_disposition_check'"
9. docker exec -i kesher-pg psql -U postgres -d club -c "set role club_app; insert into ops.case (id, kind, dedupe_key, severity, status, payload, opened_at, disposition) values (gen_random_uuid(), 'velocity', 'handoff-check', 'low', 'open', '{}', now(), 'maybe')"
10. docker exec -i kesher-pg psql -U postgres -d club -c "\dp ops.complaint"
11. docker rm -f kesher-pg
Expected: step 4 prints `ok   ledger` (6 migrations) then org, billing, legal, addons, notify, audit, agent. Step 5 reports no pending migrations for every schema. Step 6 shows ops with 12 tables (complaint added). Step 7 lists ops.complaint with status and channel checks and two indexes. Step 8 returns one row with convalidated = f. Step 9 fails with a check constraint violation on case_disposition_check (the NOT VALID constraint still guards new rows). Step 10 shows club_app with `arw` on ops.complaint.
Report back: the console output of steps 4, 6, 7, 8, 9 and 10.
