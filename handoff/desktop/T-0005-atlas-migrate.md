Task: T-0005 · Branch: claude/practical-babbage-80xevv · Needs: docker
Why: Atlas lint and apply need a real Postgres 16 (Docker) and the Atlas CLI; the cloud session only has PGlite, which runs the migrations in-process but cannot validate atlas.hcl or produce atlas.sum files.
Steps (from repo root, PowerShell on Windows unless stated):
1. docker run --name kesher-pg -e POSTGRES_PASSWORD=postgres -e POSTGRES_DB=club -p 5433:5432 -d postgres:16
2. winget install --id Ariga.Atlas -e --accept-source-agreements --accept-package-agreements
3. docker exec -i kesher-pg psql -U postgres -d club -f - < db/roles.sql
4. $env:ATLAS_URL = "postgres://postgres:postgres@localhost:5433/club?sslmode=disable"
5. foreach ($s in "ledger","identity","org","billing","legal","addons","notify","audit","agent") { if (Test-Path "db/migrations/$s") { atlas migrate hash --dir "file://db/migrations/$s" } }
6. atlas migrate lint --env local --latest 1 --var url=$env:ATLAS_URL
7. atlas migrate apply --env local --var url=$env:ATLAS_URL
8. docker exec -i kesher-pg psql -U postgres -d club -c "\dn" -c "select schemaname, tablename from pg_tables where schemaname in ('ledger','ops','agent','billing','legal','org','addons','notify','audit') order by 1,2"
9. docker rm -f kesher-pg
Expected: step 5 writes an atlas.sum next to each migration directory; step 6 reports no destructive changes; step 7 applies every schema in order with no error; step 8 lists the tables (ledger.journal, ops.transfer, org.member_spend, audit.entry, agent.grant among them).
Report back: the console output of steps 6, 7 and 8, and commit the generated db/migrations/*/atlas.sum files on this branch.
