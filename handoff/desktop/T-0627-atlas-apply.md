Task: T-0627 · Branch: claude/practical-babbage-80xevv · Needs: docker
Why: Migration org/0006 adds org.allowance_schedule_request, which keeps each create call's Idempotency-Key beside the schedule it made, so a retry answers the same schedule. The key is 8 to 128 characters and maps to one schedule; club_app may insert and read but not update or delete. This needs the real Postgres 16 apply; the cloud session only has PGlite. Each statement whose success another depends on is in its own `-c` call. Nothing here is a real institution or member.
Steps (from repo root, PowerShell on Windows unless stated):
1. docker run --name kesher-pg -e POSTGRES_PASSWORD=postgres -e POSTGRES_DB=club -p 5433:5432 -d postgres:16
2. Start-Sleep -Seconds 8
3. Get-Content -Raw db/roles.sql | docker exec -i kesher-pg psql -U postgres -d club -v ON_ERROR_STOP=1
4. node db/migrate.mjs --docker --url "postgres://postgres:postgres@localhost:5433/club?sslmode=disable"
5. node db/migrate.mjs --docker --url "postgres://postgres:postgres@localhost:5433/club?sslmode=disable"
6. docker exec -i kesher-pg psql -U postgres -d club -c "insert into org.institution (id, name, market) values ('00000000-0000-7000-8000-000000062700', 'T-0627 check', 'IL')"
7. docker exec -i kesher-pg psql -U postgres -d club -c "insert into org.allowance_schedule (id, institution_id, name, amount_minor, currency, cadence, created_by) values ('00000000-0000-7000-8000-000000062701', '00000000-0000-7000-8000-000000062700', 'Weekly', 15000, 'ILS', 'weekly', '00000000-0000-7000-8000-000000062799')"
8. docker exec -i kesher-pg psql -U postgres -d club -c "set role club_app; insert into org.allowance_schedule_request (idempotency_key, institution_id, schedule_id, request_hash, created_by, created_at) values ('t0627-key-1', '00000000-0000-7000-8000-000000062700', '00000000-0000-7000-8000-000000062701', 'h', '00000000-0000-7000-8000-000000062799', now())"
9. docker exec -i kesher-pg psql -U postgres -d club -c "set role club_app; insert into org.allowance_schedule_request (idempotency_key, institution_id, schedule_id, request_hash, created_by, created_at) values ('short', '00000000-0000-7000-8000-000000062700', '00000000-0000-7000-8000-000000062701', 'h', '00000000-0000-7000-8000-000000062799', now())"
10. docker exec -i kesher-pg psql -U postgres -d club -c "set role club_app; insert into org.allowance_schedule_request (idempotency_key, institution_id, schedule_id, request_hash, created_by, created_at) values ('t0627-key-2', '00000000-0000-7000-8000-000000062700', '00000000-0000-7000-8000-000000062701', 'h', '00000000-0000-7000-8000-000000062799', now())"
11. docker exec -i kesher-pg psql -U postgres -d club -c "set role club_app; update org.allowance_schedule_request set request_hash = 'x'"
12. docker exec -i kesher-pg psql -U postgres -d club -c "set role club_app; delete from org.allowance_schedule_request"
13. docker rm -f kesher-pg
Expected: step 4 prints `ok` for every schema, with org at 6 migrations. Step 5 reports no pending migrations. Steps 6, 7 and 8 print `INSERT 0 1`. Step 9 fails with a check constraint violation (the key's length). Step 10 fails with a unique violation on `schedule_id` (one key per schedule). Step 11 fails with `permission denied for table allowance_schedule_request`, and so does step 12.
Report back: the console output of steps 4 to 12.
