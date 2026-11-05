Task: T-0550 · Branch: card/T-0550 · Needs: docker
Why: the first T-0550 handoff ran on PGlite (no test read TEST_DATABASE_URL), so the reserve race was not exercised on real Postgres. `src/payouts/reserve-lock.pg.test.ts` (gated on TEST_PG_URL, as `balance-lock.pg.test.ts` is) races ten institution reserves of 1,000 against a 6,000 master over several connections; the master is locked and its balance re-read in the posting transaction.
Steps (from repo root, PowerShell on Windows unless stated):
1. docker run --name kesher-pg -e POSTGRES_PASSWORD=postgres -e POSTGRES_DB=club -p 5433:5432 -d postgres:16
2. Start-Sleep -Seconds 8
3. Get-Content -Raw db/roles.sql | docker exec -i kesher-pg psql -U postgres -d club -v ON_ERROR_STOP=1
4. node db/migrate.mjs --docker --url "postgres://postgres:postgres@localhost:5433/club?sslmode=disable"
5. pnpm.cmd install --frozen-lockfile
6. $env:TEST_PG_URL = "postgres://postgres:postgres@localhost:5433/club"; pnpm.cmd --filter @kesher/api exec vitest run src/payouts/reserve-lock.pg.test.ts
7. docker rm -f kesher-pg
Expected: step 4 prints `ok` for every schema. Step 6 reports 1 test passed (not skipped): exactly six of ten simultaneous reserves succeed, four are refused INSUFFICIENT_FUNDS, the master ends at 0 and the reserve at -6,000.
Report back: the console output of steps 4 and 6 (the vitest summary and any failure message), and `docker --version`.
