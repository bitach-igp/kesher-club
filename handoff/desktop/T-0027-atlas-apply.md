Task: T-0027 · Branch: claude/practical-babbage-80xevv · Needs: docker
Why: Migrations ledger/0016 and addons/0002 add `market` to ops.transfer, ops.inbound_event, ops.auto_reload and addons.addon_order, backfill existing rows to IL, and require it on every new row with a check constraint added NOT VALID. The cloud session only has PGlite, so the real Postgres 16 apply, the re-run and the constraints go on the PC. Each statement whose success another depends on is in its own `-c` call. Nothing here is a real member.
Steps (from repo root, PowerShell on Windows unless stated):
1. docker run --name kesher-pg -e POSTGRES_PASSWORD=postgres -e POSTGRES_DB=club -p 5433:5432 -d postgres:16
2. Start-Sleep -Seconds 8
3. Get-Content -Raw db/roles.sql | docker exec -i kesher-pg psql -U postgres -d club -v ON_ERROR_STOP=1
4. node db/migrate.mjs --docker --url "postgres://postgres:postgres@localhost:5433/club?sslmode=disable"
5. node db/migrate.mjs --docker --url "postgres://postgres:postgres@localhost:5433/club?sslmode=disable"
6. docker exec -i kesher-pg psql -U postgres -d club -c "select conname, convalidated from pg_constraint where conname in ('transfer_market', 'inbound_event_market', 'auto_reload_market', 'addon_order_market') order by conname"
7. docker exec -i kesher-pg psql -U postgres -d club -c "set role club_app; insert into ops.transfer (id, idempotency_key, kind, to_party_id, amount_minor, currency, state, market) values ('00000000-0000-7000-8000-000000002701', 't0027-us', 'load', '00000000-0000-7000-8000-000000002702', 100, 'USD', 'created', 'US')"
8. docker exec -i kesher-pg psql -U postgres -d club -c "set role club_app; insert into ops.transfer (id, idempotency_key, kind, to_party_id, amount_minor, currency, state) values ('00000000-0000-7000-8000-000000002703', 't0027-none', 'load', '00000000-0000-7000-8000-000000002702', 100, 'USD', 'created')"
9. docker exec -i kesher-pg psql -U postgres -d club -c "set role club_app; insert into ops.inbound_event (provider, event_id, signature_ok, payload, market) values ('simulator', 't0027-eu', true, '{}', 'EU')"
10. docker rm -f kesher-pg
Expected: step 4 prints `ok` for every schema, with ledger at 16 migrations and addons at 2. Step 5 reports no pending migrations. Step 6 lists the four constraints, each with `convalidated` = `f` (added NOT VALID, as intended). Step 7 prints `INSERT 0 1`. Step 8 fails with a check constraint violation on `transfer_market`. Step 9 fails with a check constraint violation on `inbound_event_market`.
Report back: the console output of steps 4, 5, 6, 8 and 9.
