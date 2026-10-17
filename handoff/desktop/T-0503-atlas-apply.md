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
