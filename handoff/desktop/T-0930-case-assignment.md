Task: T-0930 · Branch: claude/practical-babbage-80xevv · Needs: docker
Why: Migration ledger/0024 adds `assigned_to` and `assigned_at` to ops.case, so an ops case can be taken by one staff member before it is resolved or dismissed (REQ-ADM-005). This applies it on real Postgres 16 and checks that the app role can set the new columns on an existing case. Each statement whose success another depends on is in its own `-c` call. Nothing here is real data.
Steps (from repo root, PowerShell on Windows unless stated):
1. docker run --name kesher-pg -e POSTGRES_PASSWORD=postgres -e POSTGRES_DB=club -p 5433:5432 -d postgres:16
2. Start-Sleep -Seconds 8
3. Get-Content -Raw db/roles.sql | docker exec -i kesher-pg psql -U postgres -d club -v ON_ERROR_STOP=1
4. node db/migrate.mjs --docker --url "postgres://postgres:postgres@localhost:5433/club?sslmode=disable"
5. docker exec -i kesher-pg psql -U postgres -d club -c "set role club_app; insert into ops.case (id, kind, dedupe_key, severity, status, payload, opened_at) values ('00000000-0000-7000-8000-000000093001', 'balance_break', 't0930-check', 'high', 'open', '{}', now())"
6. docker exec -i kesher-pg psql -U postgres -d club -c "set role club_app; update ops.case set assigned_to = 'ops-admin-a', assigned_at = now(), status = 'investigating' where id = '00000000-0000-7000-8000-000000093001'"
7. docker exec -i kesher-pg psql -U postgres -d club -c "select assigned_to, status from ops.case where id = '00000000-0000-7000-8000-000000093001'"
8. docker rm -f kesher-pg
Expected: step 4 prints `ok` for every schema, with ledger at 24 migrations. Step 5 prints `SET` then `INSERT 0 1`; step 6 `SET` then `UPDATE 1`; step 7 one row: `ops-admin-a | investigating`.
Report back: the console output of steps 4 to 7.
