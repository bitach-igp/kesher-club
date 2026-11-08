Task: T-0065 · Branch: card/T-0065 · Needs: docker
Why: Migration ledger/0029 widens the ops.approval_request kind check with `legal_publish` (dropped and re-added NOT VALID). This applies it on real Postgres 16, checks atlas.sum, and checks that the app role can insert a `legal_publish` request and cannot insert an unknown kind. Each statement whose success another depends on is in its own `-c` call; the last one is meant to fail. Nothing here is real data.
Steps (from repo root, PowerShell on Windows unless stated):
1. docker run --name kesher-pg -e POSTGRES_PASSWORD=postgres -e POSTGRES_DB=club -p 5433:5432 -d postgres:16
2. Start-Sleep -Seconds 8
3. Get-Content -Raw db/roles.sql | docker exec -i kesher-pg psql -U postgres -d club -v ON_ERROR_STOP=1
4. node db/migrate.mjs --docker --url "postgres://postgres:postgres@localhost:5433/club?sslmode=disable"
5. atlas migrate hash --dir file://db/migrations/ledger
6. git status --short db/migrations/ledger/atlas.sum
7. pnpm db:lint
8. docker exec -i kesher-pg psql -U postgres -d club -c "set role club_app; insert into ops.approval_request (id, kind, subject, required, scope, requested_by, status, expires_at) values ('0192f3a4-0000-7000-8000-0000000000a1', 'legal_publish', 'legal_publish:terms:handoff-check', 2, 'platform', '0192f3a4-0000-7000-8000-0000000000b1', 'awaiting_second_approval', now() + interval '7 days')"
9. docker exec -i kesher-pg psql -U postgres -d club -c "select kind, status from ops.approval_request where id = '0192f3a4-0000-7000-8000-0000000000a1'"
10. docker exec -i kesher-pg psql -U postgres -d club -c "set role club_app; insert into ops.approval_request (id, kind, subject, required, scope, requested_by, status, expires_at) values ('0192f3a4-0000-7000-8000-0000000000a2', 'not_a_kind', 'bogus', 2, 'platform', '0192f3a4-0000-7000-8000-0000000000b1', 'awaiting_second_approval', now() + interval '7 days')"
11. docker rm -f kesher-pg
Expected: step 4 prints `ok` for every schema, with ledger at 29 migrations. Step 5 prints nothing and step 6 prints nothing (no diff to atlas.sum). Step 7 ends `db lint: squawk ok`. Step 8 prints `SET` then `INSERT 0 1`; step 9 one row: `legal_publish | awaiting_second_approval`. Step 10 prints `SET` then `ERROR:  new row for relation "approval_request" violates check constraint "approval_request_kind_check"`.
Report back: the console output of steps 4 to 10.

## Result
PASS, 2026-11-08 19:10 (Asia/Jerusalem), desktop runner at c35ba7d (Docker 29.9.2). Two deviations, both tooling on the Windows PC, not the migration:
- Step 4: all nine schemas `ok`; ledger "Migrating to version 0029 (29 migrations in total)", the re-added `approval_request_kind_check ... 'legal_publish')) not valid;` -> ok (25.1ms).
- Step 5: no `atlas` binary on the PC's PATH, so run as `docker run --rm -v ${PWD}:/work -w /work arigaio/atlas:latest migrate hash --dir file://db/migrations/ledger` (the image db/migrate.mjs --docker uses): no output, exit 0.
- Step 6: no output (atlas.sum unchanged).
- Step 7: on Windows `pnpm db:lint` prints `db lint: house rules ok` then fails with `squawk: spawnSync npx.cmd EINVAL` (Node refuses to spawn a .cmd without a shell; a db/lint.mjs Windows issue, not this card). In the cloud container on main+card/T-0065 (Linux): `db lint: squawk ok`, tests 26 pass / 0 fail.
- Step 8: `SET`, `INSERT 0 1`. Step 9: `legal_publish | awaiting_second_approval` (1 row).
- Step 10: `SET`, `ERROR:  new row for relation "approval_request" violates check constraint "approval_request_kind_check"` (as expected).
- Step 11: container removed.
