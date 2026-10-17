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

## Blocked
Date: 2026-10-16 18:10 Asia/Jerusalem (desktop checker, first run)
Outcome: not run. Zvi's PC has no Docker: `docker` is not on PATH, Docker Desktop is not installed
(`C:\Program Files\Docker\Docker\resources\bin\docker.exe` missing) and WSL is not installed
("The Windows Subsystem for Linux is not installed"). Atlas CLI is also absent. Installing Docker
Desktop + WSL needs admin/system changes and a reboot, well over the 20-minute limit, so the checker
will not do it unattended.
To unblock: Zvi installs Docker Desktop (with WSL 2) and, optionally, Atlas; then re-file this
request under handoff/desktop/ (or reply in the PR) and the next run will execute steps 1-9.

## Result
Date: 2026-10-17 (Asia/Jerusalem), desktop checker, re-run on Zvi's request after he installed WSL 2 + Docker Desktop.
Branch head when run: fd4bedc. Outcome: PARTIAL. Migrations apply cleanly in the intended order, but `atlas migrate lint` is blocked and the `local` env cannot run as written.

Deviations from the steps:
- Step 2: `winget install --id Ariga.Atlas` → "No package found matching input criteria". Ran Atlas from the official Docker image instead (`arigaio/atlas:latest`, reports v1.3.5-aec010a-canary) with the worktree mounted at /work and Postgres reached via host.docker.internal:5433.
- atlas.hcl lives at db/atlas.hcl, so `--config file://db/atlas.hcl` was needed.

Step 3 (roles.sql): OK (DO, DO, REVOKE, ALTER ROLE x6, ALTER DEFAULT PRIVILEGES).
Step 5 (hash): OK for ledger, org, billing, legal, addons, notify, audit, agent (no db/migrations/identity dir). atlas.sum files committed with this result.
Step 6 (lint): BLOCKED, not run.
  - `--env local --latest 1` → `Error: multiple envs found for "local"` (lint does not support for_each envs).
  - Per-dir `migrate lint --dir ... --dev-url ...` → `Abort: Starting with v0.38, 'atlas migrate lint' is available only to Atlas Pro users. ... atlas login`. The checker never signs in; needs a decision (Atlas login in CI, or a different lint such as squawk).
Step 7 (apply):
  - As written (`--env local`) → FAILED: for_each over `toset(local.schemas)` runs envs in alphabetical order, so `addons` ran first: `pq: schema "ledger" does not exist at position 8:19 (3F000)`. The "Order matters" comment in atlas.hcl is not honoured.
  - Per dir in the intended order on a fresh DB (`migrate apply --url ... --dir file://db/migrations/<s> --revisions-schema atlas_<s>`): ledger OK (4 migrations). org then failed with `connected database is not clean: found schema "agent". baseline version or allow-dirty is required` (ledger/0001 also creates ops and agent). With `--allow-dirty`: org (2), billing, legal, addons, notify, audit, agent all OK.
Step 8: schemas = addons, agent, audit, billing, ledger, legal, notify, ops, org, public (+ atlas_* revision schemas). 45 tables, including ledger.journal, ledger.posting, ledger.account, ledger.account_balance, ops.transfer, ops.external_ref, org.member_spend, audit.entry, agent.grant.
  - Extra check: club_app holds UPDATE on ledger.account_balance (ledger/0001_init.sql:92, `grant update on ledger.account_balance to club_app;`). Constitution art. 3 says "No UPDATE or DELETE on `ledger.*`". Either move the balance projection out of the ledger schema or record the exception in the constitution.
Step 9: container removed.

Asks for the cloud session:
1. Fix db/atlas.hcl ordering (for_each sorts the set alphabetically). Options: one env per schema applied in order by a script, or prefix names so alphabetical order equals dependency order, or a single migration dir.
2. Each per-schema apply after ledger needs `--allow-dirty` (or baseline) because schemas share the database. Bake that into the env/script.
3. Decide on lint: Atlas Pro login (in CI only) or a community linter.
4. Resolve the ledger.account_balance UPDATE grant against constitution art. 3.
