Task: T-0558 · Branch: card/T-0558 · Needs: docker
Why: Migration ledger/0032 adds ops.load_check (transfer_id uuid primary key references ops.transfer, last_asked_at timestamptz not null), the marker the load sweep uses to ask the vendor about a held load once per interval. It needs the real Postgres 16 apply and a check of the grants: club_app may select, insert and update but not delete, and the foreign key refuses a marker for a transfer that does not exist. The cloud session only has PGlite. Each statement whose success another depends on is in its own `-c` call. Nothing here is a real member or vendor load.
Steps (from repo root, PowerShell on Windows unless stated):
1. docker run --name kesher-pg -e POSTGRES_PASSWORD=postgres -e POSTGRES_DB=club -p 5433:5432 -d postgres:16
2. Start-Sleep -Seconds 8
3. Get-Content -Raw db/roles.sql | docker exec -i kesher-pg psql -U postgres -d club -v ON_ERROR_STOP=1
4. node db/migrate.mjs --docker --url "postgres://postgres:postgres@localhost:5433/club?sslmode=disable"
5. node db/migrate.mjs --docker --url "postgres://postgres:postgres@localhost:5433/club?sslmode=disable"
6. docker exec -i kesher-pg psql -U postgres -d club -c "insert into ops.transfer (id, idempotency_key, kind, to_party_id, amount_minor, currency, state, hold_releases_at, market, created_at, updated_at) values ('00000000-0000-7000-8000-000000055800', 'seed-t0558-1', 'load', '00000000-0000-7000-8000-000000055800', 100, 'USD', 'pending_hold', now() + interval '3 days', 'US', now(), now())"
7. docker exec -i kesher-pg psql -U postgres -d club -c "set role club_app; insert into ops.load_check (transfer_id, last_asked_at) values ('00000000-0000-7000-8000-000000055800', now())"
8. docker exec -i kesher-pg psql -U postgres -d club -c "set role club_app; insert into ops.load_check (transfer_id, last_asked_at) values ('00000000-0000-7000-8000-000000055800', now()) on conflict (transfer_id) do update set last_asked_at = excluded.last_asked_at"
9. docker exec -i kesher-pg psql -U postgres -d club -c "set role club_app; insert into ops.load_check (transfer_id, last_asked_at) values ('00000000-0000-7000-8000-000000055899', now())"
10. docker exec -i kesher-pg psql -U postgres -d club -c "set role club_app; delete from ops.load_check"
11. docker exec -i kesher-pg psql -U postgres -d club -c "select transfer_id, last_asked_at is not null as asked from ops.load_check"
12. docker rm -f kesher-pg
Expected: step 4 prints `ok` for every schema, with ledger at 32 migrations. Step 5 reports no pending migrations. Step 6 prints `INSERT 0 1`. Step 7 prints `INSERT 0 1`. Step 8 prints `INSERT 0 1` (the upsert updates the one row). Step 9 fails with a foreign key violation (no such transfer). Step 10 fails with `permission denied for table load_check`. Step 11 prints one row, asked = t.
Report back: the console output of steps 4 to 11.

## Result
Outcome: PASS, every step matched Expected. Run 2026-11-10 22:10 (Asia/Jerusalem) by the desktop checker in the runner worktree at 361ee4c, Docker postgres:16 on port 5433, container removed afterwards.
- Step 4: `Migrating to version 0032 (32 migrations in total)`, `-- migrating version 0032` -> `create table ops.load_check (...)`, `grant select, insert, update on ops.load_check to club_app`; summary `ok` for ledger, identity, org, billing, legal, addons, notify, audit, agent.
- Step 5: `No migration files to execute` for every schema, then `ok` for each.
- Step 6: `INSERT 0 1`.
- Step 7: `SET` / `INSERT 0 1`.
- Step 8: `SET` / `INSERT 0 1` (upsert).
- Step 9: `ERROR:  insert or update on table "load_check" violates foreign key constraint "load_check_transfer_id_fkey"` / `DETAIL:  Key (transfer_id)=(00000000-0000-7000-8000-000000055899) is not present in table "transfer".`
- Step 10: `ERROR:  permission denied for table load_check`.
- Step 11: one row, `00000000-0000-7000-8000-000000055800 | t`.
- Step 12: `kesher-pg` (removed).
