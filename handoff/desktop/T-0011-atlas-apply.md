Task: T-0011 · Branch: claude/practical-babbage-80xevv · Needs: docker
Why: Applying the migrations needs a real Postgres 16 and the Atlas image; the cloud session only has PGlite. This re-runs the T-0005 apply through the new ordered runner, which the earlier result showed cannot work with `--env local`.
Steps (from repo root, PowerShell on Windows unless stated):
1. docker run --name kesher-pg -e POSTGRES_PASSWORD=postgres -e POSTGRES_DB=club -p 5433:5432 -d postgres:16
2. Start-Sleep -Seconds 8
3. Get-Content -Raw db/roles.sql | docker exec -i kesher-pg psql -U postgres -d club -v ON_ERROR_STOP=1
4. node db/migrate.mjs --docker --url "postgres://postgres:postgres@localhost:5433/club?sslmode=disable"
5. node db/migrate.mjs --docker --url "postgres://postgres:postgres@localhost:5433/club?sslmode=disable"
6. docker exec -i kesher-pg psql -U postgres -d club -c "select schemaname, count(*) as tables from pg_tables where schemaname in ('ledger','ops','agent','billing','legal','org','addons','notify','audit') group by 1 order by 1"
7. docker rm -f kesher-pg
Expected: step 4 prints `ok   ledger`, then org, billing, legal, addons, notify, audit, agent in that order (identity is skipped: no directory), each Atlas run applying its migrations without a "not clean" error. Step 5 prints the same `ok` lines with Atlas reporting no pending migrations for every schema. Step 6 lists the nine schemas with their table counts (ledger 4+, ops, agent among them).
Report back: the console output of steps 4, 5 and 6.
