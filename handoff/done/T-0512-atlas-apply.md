Task: T-0512 · Branch: claude/practical-babbage-80xevv · Needs: docker
Why: Migration ledger/0013 creates ops.fx_rate (the club's published rates, one active per pair) and widens the ops.approval_request kind check to allow 'fx_rate'; the cloud session only has PGlite, so the real Postgres 16 apply, the constraint checks and the re-run go on the PC. Each statement whose success another depends on is in its own `-c` call.
Steps (from repo root, PowerShell on Windows unless stated):
1. docker run --name kesher-pg -e POSTGRES_PASSWORD=postgres -e POSTGRES_DB=club -p 5433:5432 -d postgres:16
2. Start-Sleep -Seconds 8
3. Get-Content -Raw db/roles.sql | docker exec -i kesher-pg psql -U postgres -d club -v ON_ERROR_STOP=1
4. node db/migrate.mjs --docker --url "postgres://postgres:postgres@localhost:5433/club?sslmode=disable"
5. node db/migrate.mjs --docker --url "postgres://postgres:postgres@localhost:5433/club?sslmode=disable"
6. docker exec -i kesher-pg psql -U postgres -d club -c "\d ops.fx_rate"
7. docker exec -i kesher-pg psql -U postgres -d club -c "set role club_app; insert into ops.fx_rate (id, pair, version, mid_scaled, source, status, valid_from, valid_until, proposed_by) values (gen_random_uuid(), 'USD/ILS', 1, 3710000, 'port', 'active', now(), now() + interval '15 minutes', 'worker')"
8. docker exec -i kesher-pg psql -U postgres -d club -c "set role club_app; insert into ops.fx_rate (id, pair, version, mid_scaled, source, status, valid_from, proposed_by) values (gen_random_uuid(), 'USD/ILS', 2, 3700000, 'manual', 'active', now(), 'auth0|handoff')"
9. docker exec -i kesher-pg psql -U postgres -d club -c "set role club_app; insert into ops.approval_request (id, kind, subject, required, scope, requested_by, status, expires_at) values (gen_random_uuid(), 'fx_rate', 'fx_rate:handoff', 2, 'platform', '00000000-0000-7000-8000-00000000a512', 'awaiting_second_approval', now() + interval '7 days')"
10. docker exec -i kesher-pg psql -U postgres -d club -c "set role club_app; insert into ops.approval_request (id, kind, subject, required, scope, requested_by, status, expires_at) values (gen_random_uuid(), 'bogus', 'bogus:handoff', 2, 'platform', '00000000-0000-7000-8000-00000000a512', 'pending', now() + interval '7 days')"
11. docker exec -i kesher-pg psql -U postgres -d club -c "\dp ops.fx_rate"
12. docker rm -f kesher-pg
Expected: step 4 prints `ok   ledger` (13 migrations) then identity, org, billing, legal, addons, notify, audit, agent. Step 5 reports no pending migrations for every schema. Step 6 lists ops.fx_rate with checks on pair, mid_scaled, source and status, the unique (pair, version), the partial unique index fx_rate_one_active_idx on (pair) WHERE status = 'active', the fx_rate_pair_created_idx index and the FK to ops.approval_request. Step 7 prints `INSERT 0 1`. Step 8 fails with a duplicate key violation on fx_rate_one_active_idx (one active rate per pair). Step 9 prints `INSERT 0 1`. Step 10 fails with a check constraint violation on approval_request_kind_check. Step 11 shows club_app with `arw` on ops.fx_rate.
Report back: the console output of steps 4, 6, 7, 8, 9, 10 and 11.

## Result
Date: 2026-10-18 21:07 Asia/Jerusalem (desktop checker)
Outcome: PASS, run at 0dbaaa2 (branch head, ledger 14 / identity 2 migrations) in postgres:16.
- Step 4: ledger "Migrating to version 0014 (14 migrations in total)"; 0013 created ops.fx_rate, fx_rate_one_active_idx, fx_rate_pair_created_idx and re-added approval_request_kind_check with 'fx_rate' NOT VALID, "-- ok (87.8ms)". Then `ok` for ledger, identity, org, billing, legal, addons, notify, audit, agent.
- Step 5 re-run: "No migration files to execute" x9, all ok.
- Step 6: \d ops.fx_rate shows fx_rate_pkey, fx_rate_one_active_idx UNIQUE (pair) WHERE status = 'active', fx_rate_pair_created_idx (pair, created_at DESC), fx_rate_pair_version_key UNIQUE (pair, version); checks fx_rate_mid_scaled_check, fx_rate_pair_check, fx_rate_source_check, fx_rate_status_check; FK fx_rate_approval_id_fkey -> ops.approval_request(id). As expected.
- Step 7: `INSERT 0 1`. As expected.
- Step 8: `ERROR: duplicate key value violates unique constraint "fx_rate_one_active_idx"` (Key (pair)=(USD/ILS) already exists). As expected.
- Step 9: `INSERT 0 1`. As expected.
- Step 10: `ERROR: new row for relation "approval_request" violates check constraint "approval_request_kind_check"`. As expected.
- Step 11: ops.fx_rate privileges `club_app=arw/postgres`. As expected.
- Step 12: container removed. (Error texts for steps 8 and 10 captured on a second fresh container at the same commit; the first run showed no INSERT for both.)
