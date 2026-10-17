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

## Result
Run 2026-10-17 ~21:10 (Asia/Jerusalem) on Zvi's PC (Windows, Docker 29.8.2, Node 24.19.0), runner worktree.

- First run at f5fee6f: steps 4 and 5 printed nothing and exited 0 — on Windows `new URL(import.meta.url).pathname` is `/C:/...`, so the CLI guard never matched (ROOT also resolved to `C:\C:\...`). Fixed in d2de1d9 (`fileURLToPath`), then re-ran all steps at d2de1d9:
- Step 3 (roles.sql): exit 0.
- Step 4: exit 0. Atlas "Migrating to version 0004 (4 migrations)" for ledger, 0002 for org, 0001 for the rest; no "not clean" errors.
  `ok ledger / ok org / ok billing / ok legal / ok addons / ok notify / ok audit / ok agent` (identity skipped).
- Step 5: exit 0. "No migration files to execute" ×8, same eight `ok` lines.
- Step 6: addons 4 · agent 4 · audit 1 · billing 5 · ledger 4 · legal 2 · notify 3 · ops 10 · org 12 (9 rows).
- Step 7: container removed.
Outcome: PASS.
