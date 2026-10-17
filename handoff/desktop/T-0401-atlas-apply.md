Task: T-0401 · Branch: claude/practical-babbage-80xevv · Needs: docker
Why: identity/0001 is the identity schema's first migration (identity.kyc_session) and the first run of the runner through a schema it used to skip; the cloud session only has PGlite, so the real Postgres 16 apply, the ordering check and the re-run go on the PC.
Steps (from repo root, PowerShell on Windows unless stated):
1. docker run --name kesher-pg -e POSTGRES_PASSWORD=postgres -e POSTGRES_DB=club -p 5433:5432 -d postgres:16
2. Start-Sleep -Seconds 8
3. Get-Content -Raw db/roles.sql | docker exec -i kesher-pg psql -U postgres -d club -v ON_ERROR_STOP=1
4. node db/migrate.mjs --docker --url "postgres://postgres:postgres@localhost:5433/club?sslmode=disable"
5. node db/migrate.mjs --docker --url "postgres://postgres:postgres@localhost:5433/club?sslmode=disable"
6. docker exec -i kesher-pg psql -U postgres -d club -c "select schemaname, count(*) as tables from pg_tables where schemaname in ('ledger','ops','identity','agent','billing','legal','org','addons','notify','audit') group by 1 order by 1"
7. docker exec -i kesher-pg psql -U postgres -d club -c "\d identity.kyc_session"
8. docker exec -i kesher-pg psql -U postgres -d club -c "\dp identity.kyc_session"
9. docker exec -i kesher-pg psql -U postgres -d club -c "select version from atlas_identity.atlas_schema_revisions"
10. docker rm -f kesher-pg
Expected: step 4 prints `ok   ledger` then `ok   identity` (1 migration) before org, billing, legal, addons, notify, audit, agent. Step 5 reports no pending migrations for every schema. Step 6 shows identity with 1 table. Step 7 lists session_id as the primary key with tier, market and status checks and one index on (party_id, started_at desc); no column holds a token or an image. Step 8 shows club_app with `arw` on identity.kyc_session. Step 9 returns one row, 0001.
Report back: the console output of steps 4, 6, 7, 8 and 9.
