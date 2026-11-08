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
