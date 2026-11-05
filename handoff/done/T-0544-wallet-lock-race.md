Task: T-0544 · Branch: card/T-0544 · Needs: docker
Why: the per-wallet lock (`PostgresLedger.postNoOverdraft`, advisory locks taken in account order, balance re-checked inside the posting transaction) can only be shown to hold with several real connections racing; PGlite is one connection. No schema change: the migrations are applied only so the test has the real tables, roles and triggers.
Steps (from repo root, PowerShell on Windows unless stated):
1. docker run --name kesher-pg -e POSTGRES_PASSWORD=postgres -e POSTGRES_DB=club -p 5433:5432 -d postgres:16
2. Start-Sleep -Seconds 8
3. Get-Content -Raw db/roles.sql | docker exec -i kesher-pg psql -U postgres -d club -v ON_ERROR_STOP=1
4. node db/migrate.mjs --docker --url "postgres://postgres:postgres@localhost:5433/club?sslmode=disable"
5. pnpm install --frozen-lockfile
6. $env:TEST_PG_URL = "postgres://postgres:postgres@localhost:5433/club"; pnpm --filter @kesher/api exec vitest run src/ledger/balance-lock.pg.test.ts
7. docker rm -f kesher-pg
Expected: step 4 prints `ok` for every schema. Step 6 reports 5 tests passed: of two simultaneous debits of a whole balance exactly one succeeds and the wallet ends at zero; of thirty simultaneous debits of 1,000 against 10,000 exactly ten succeed; one key raced eight times posts once; opposite sends between two wallets finish without a deadlock (no `40P01`); the p99 of 200 serial posts is under 100 ms.
Report back: the console output of steps 4 and 6 (the vitest summary and any failure message), and `docker --version`.

## Result
PASS, 2026-11-05 00:06 Asia/Jerusalem, desktop runner worktree at b98ed7d. `docker --version`: Docker version 29.9.2, build a82e528.
- Steps 1-3: container up; roles.sql applied (ALTER ROLE ×5).
- Step 4: `ok` for every schema: ledger, identity, org, billing, legal, addons, notify, audit, agent.
- Step 5: install done in 4.6s (pnpm v10.28.0).
- Step 6: `src/ledger/balance-lock.pg.test.ts (5 tests) 2597ms` - Test Files 1 passed (1), Tests 5 passed (5); p99 test (200 serial posts under 100 ms) 2052ms total. No failures, no 40P01.
- Step 7: container removed.
- Re-run 2026-11-05 00:15 Asia/Jerusalem on 1b1b25b (after 2cd0a21 changed post.ts debit summing): migrations `ok` for all 9 schemas; `balance-lock.pg.test.ts (5 tests) 3005ms`, Tests 5 passed (5).
