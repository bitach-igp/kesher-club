Task: T-0684 · Branch: card/T-0684 · Needs: docker
Why: Migration ledger/0030 adds an index on ledger.journal (transfer_id) for the nightly partner reconciliation; the cloud session only has PGlite, so the real Postgres 16 apply, the Atlas hash check and the plan check go on the PC.
Steps (from repo root, PowerShell on Windows unless stated):
1. docker run --name kesher-pg -e POSTGRES_PASSWORD=postgres -e POSTGRES_DB=club -p 5433:5432 -d postgres:16
2. Start-Sleep -Seconds 8
3. Get-Content -Raw db/roles.sql | docker exec -i kesher-pg psql -U postgres -d club -v ON_ERROR_STOP=1
4. node db/migrate.mjs --docker --url "postgres://postgres:postgres@localhost:5433/club?sslmode=disable"
5. node db/migrate.mjs --docker --url "postgres://postgres:postgres@localhost:5433/club?sslmode=disable"
6. docker exec -i kesher-pg psql -U postgres -d club -c "select indexname, indexdef from pg_indexes where schemaname = 'ledger' and tablename = 'journal' and indexname = 'journal_transfer_id_idx'"
7. docker exec -i kesher-pg psql -U postgres -d club -c "set enable_seqscan = off; explain select id from ledger.journal where transfer_id = '00000000-0000-7000-8000-000000000000'"
8. docker exec -i kesher-pg psql -U postgres -d club -c "select grantee, privilege_type from information_schema.role_table_grants where grantee = 'club_app' and table_schema = 'ledger' and table_name = 'journal'"
9. docker rm -f kesher-pg
Expected: step 4 prints `ok   ledger` with 0030 applied (Atlas accepts atlas.sum, which was recomputed by hand because the atlas CLI was not available in the cloud session) and step 5 reports no pending migrations. Step 6 returns one row, a partial btree index `WHERE (transfer_id IS NOT NULL)`. Step 7's plan names `journal_transfer_id_idx`. Step 8 shows club_app with only INSERT and SELECT.
Report back: the console output of steps 4, 6, 7 and 8.

## Result
PASS, 2026-11-10 03:08 Asia/Jerusalem, runner worktree at 0b50b58, Docker 29.9.2, postgres:16.
- First attempt failed at step 4 (`role "club_app" does not exist`): the PowerShell 5.1 pipe in step 3 prepended a BOM to roles.sql. Reran on a fresh container with a BOM-less `$OutputEncoding`; everything below is from that run.
- Step 3: `ALTER ROLE` lines, no errors.
- Step 4: `Migrating to version 0030 (30 migrations in total)`, `-- migrating version 0030`; `ok` for all nine schemas (ledger, identity, org, billing, legal, addons, notify, audit, agent). Atlas accepted the hand-computed atlas.sum.
- Step 5: `No migration files to execute` for every schema, `ok` for all nine.
- Step 6: one row: `journal_transfer_id_idx | CREATE INDEX journal_transfer_id_idx ON ledger.journal USING btree (transfer_id) WHERE (transfer_id IS NOT NULL)`.
- Step 7: `Bitmap Heap Scan on journal` / `->  Bitmap Index Scan on journal_transfer_id_idx` / `Index Cond: (transfer_id = '00000000-0000-7000-8000-000000000000'::uuid)`.
- Step 8: `club_app | INSERT`, `club_app | SELECT` (2 rows).
- Step 9: container removed.
