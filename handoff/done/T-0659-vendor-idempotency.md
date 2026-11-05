Task: T-0659 · Branch: opencode/T-0659-crowded-wiring · Needs: docker
Why: Migration ledger/0026 adds ops.vendor_idempotency, the insert-only idempotency ledger for the Crowded adapter (REQ-INS-022, REQ-INS-025). The cloud session has only PGlite and no Atlas CLI, so `atlas.sum` could not be refreshed there and the real Postgres 16 apply and the grant check go on the PC. Each statement whose success another depends on is in its own `-c` call; the last two are meant to fail. Nothing here is real data.
Steps (from repo root, PowerShell on Windows unless stated):
1. docker run --rm -v "${PWD}:/work" -w /work arigaio/atlas:latest migrate hash --dir file://db/migrations/ledger
2. git diff --stat db/migrations/ledger/atlas.sum
3. docker run --name kesher-pg -e POSTGRES_PASSWORD=postgres -e POSTGRES_DB=club -p 5433:5432 -d postgres:16
4. Start-Sleep -Seconds 8
5. Get-Content -Raw db/roles.sql | docker exec -i kesher-pg psql -U postgres -d club -v ON_ERROR_STOP=1
6. node db/migrate.mjs --docker --url "postgres://postgres:postgres@localhost:5433/club?sslmode=disable"
7. node db/migrate.mjs --docker --url "postgres://postgres:postgres@localhost:5433/club?sslmode=disable"
8. docker exec -i kesher-pg psql -U postgres -d club -c "set role club_app; insert into ops.vendor_idempotency (provider, key, body_hash, result, created_at) values ('crowded', 'entity:t0659-check', 'hash-a', '{}', now())"
9. docker exec -i kesher-pg psql -U postgres -d club -c "select provider, key, body_hash, result from ops.vendor_idempotency where provider = 'crowded' and key = 'entity:t0659-check'"
10. docker exec -i kesher-pg psql -U postgres -d club -c "set role club_app; insert into ops.vendor_idempotency (provider, key, body_hash, result, created_at) values ('crowded', 'entity:t0659-check', 'hash-b', null, now())"
11. docker exec -i kesher-pg psql -U postgres -d club -c "set role club_app; update ops.vendor_idempotency set body_hash = 'hash-b' where key = 'entity:t0659-check'"
12. docker exec -i kesher-pg psql -U postgres -d club -c "set role club_app; delete from ops.vendor_idempotency where key = 'entity:t0659-check'"
13. docker exec -i kesher-pg psql -U postgres -d club -c "select grantee, privilege_type from information_schema.role_table_grants where table_schema = 'ops' and table_name = 'vendor_idempotency' and grantee = 'club_app' order by 2"
14. docker rm -f kesher-pg
Expected: step 1 rewrites db/migrations/ledger/atlas.sum (step 2 shows the file changed, with a new `0026_vendor_idempotency.sql` line); commit that file on this branch. Step 6 prints `ok` for every schema, with ledger at 26 migrations (`Migrating to version 0026`); step 7 reports no pending migrations. Step 8 prints `SET` then `INSERT 0 1`. Step 9 shows one row `crowded | entity:t0659-check | hash-a | {}`. Step 10 prints `SET` then `ERROR:  duplicate key value violates unique constraint "vendor_idempotency_pkey"`. Steps 11 and 12 each print `SET` then `ERROR:  permission denied for table vendor_idempotency`. Step 13 lists exactly two rows: `club_app | INSERT` and `club_app | SELECT`.
Report back: the console output of steps 2 and 6 to 13, and the committed db/migrations/ledger/atlas.sum.

## Result
PASS, 2026-11-04 04:10 Asia/Jerusalem, on the PC runner worktree at 53040d7 (Docker Desktop 29.8.2, postgres:16, arigaio/atlas:latest).
- Steps 1-2: `atlas migrate hash` rewrote `db/migrations/ledger/atlas.sum` (`1 file changed, 2 insertions(+), 1 deletion(-)`): new sum line and `0026_vendor_idempotency.sql h1:FGHTKmybciRi9equ+aZ+VJhz9FEZMv7JZH9Jx1vVgZs=`. Committed with this result.
- Step 6: applied (its console output was lost to a remote-call timeout); confirmed afterwards: `atlas_ledger.atlas_schema_revisions` count 26, max version 0026, and `ops.vendor_idempotency` exists.
- Step 7: `No migration files to execute` for every schema, then `ok` for ledger, identity, org, billing, legal, addons, notify, audit, agent (exit 0).
- Step 8: `SET` / `INSERT 0 1`.
- Step 9: one row `crowded | entity:t0659-check | hash-a | {}`.
- Step 10: `ERROR:  duplicate key value violates unique constraint "vendor_idempotency_pkey"` (Key (provider, key)=(crowded, entity:t0659-check) already exists).
- Steps 11, 12: `SET` then `ERROR:  permission denied for table vendor_idempotency` (each).
- Step 13: exactly two rows: `club_app | INSERT`, `club_app | SELECT`.
- Step 14: container removed.
