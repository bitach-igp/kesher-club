Task: T-0550 · Branch: card/T-0550 · Needs: docker
Why: an institution payout now posts a journal master → `payout_reserve` under the master's advisory lock with an in-transaction balance guard, then posts out of the reserve at submit. The lock, the guard and the sum over both accounts must behave on real Postgres 16 (PGlite is single-connection and cannot show the race).
Steps (from repo root, PowerShell on Windows unless stated):
1. docker run --name kesher-pg -e POSTGRES_PASSWORD=postgres -e POSTGRES_DB=club -p 5433:5432 -d postgres:16
2. Start-Sleep -Seconds 8
3. Get-Content -Raw db/roles.sql | docker exec -i kesher-pg psql -U postgres -d club -v ON_ERROR_STOP=1
4. node db/migrate.mjs --docker --url "postgres://postgres:postgres@localhost:5433/club?sslmode=disable"
5. $env:TEST_DATABASE_URL="postgres://postgres:postgres@localhost:5433/club?sslmode=disable"; pnpm --filter @kesher/api exec vitest run src/payouts
6. docker rm -f kesher-pg
Expected: step 4 prints `ok` for every schema; step 5 passes (the payouts tests run against the real database where they support it; if none are gated on TEST_DATABASE_URL say so and report the PGlite result instead).
Report back: the console output of steps 4 and 5, and `docker --version`.

## Result
PASS (with a caveat) · 2026-11-05 13:59 Asia/Jerusalem · runner worktree at 14ab96b
- `docker --version`: Docker version 29.9.2, build a82e528
- Step 3: roles.sql applied (ALTER ROLE ×3).
- Step 4: migrated to version 0027 (27 migrations); `ok` for ledger, identity, org, billing, legal, addons, notify, audit, agent.
- Step 5: `src/payouts`: iban 3/3, handlers 8/8, service 25/25. Test Files 3 passed, Tests 36 passed (8.36s).
- Caveat: no test under `apps/api/src` reads `TEST_DATABASE_URL`, so step 5 ran on PGlite, not the Postgres 16 container. The advisory-lock / balance-guard race on real Postgres is not exercised; a test gated on `TEST_DATABASE_URL` would be needed for that.
- Step 6: container removed.
- Note: on this PC `pnpm` must be called as `pnpm.cmd` from PowerShell (script execution policy blocks `pnpm.ps1`).
