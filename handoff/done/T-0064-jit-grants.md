Task: T-0064 · Branch: card/T-0064 · Needs: docker
Why: ledger/0028, billing/0006 and audit/0002 grant the club_jit role exactly what a card authorisation does; PGlite has no roles, so only a real Postgres 16 shows the grants are enough (an authorisation approves as club_jit) and not too much (the privilege matrix, and statements club_jit must be refused).
Steps (from repo root, PowerShell on Windows unless stated; the password below is a throwaway for this local container):
1. docker run --name kesher-pg -e POSTGRES_PASSWORD=postgres -e POSTGRES_DB=club -p 5433:5432 -d postgres:16
2. Start-Sleep -Seconds 8
3. Get-Content -Raw db/roles.sql | docker exec -i kesher-pg psql -U postgres -d club -v ON_ERROR_STOP=1
4. docker exec kesher-pg psql -U postgres -d club -c "alter role club_jit password 'jit-pw-1'"
5. docker exec kesher-pg psql -U postgres -d club -c "grant connect on database club to club_jit"
6. node db/migrate.mjs --docker --url "postgres://postgres:postgres@localhost:5433/club?sslmode=disable"
7. pnpm install --frozen-lockfile
8. $env:TEST_PG_URL = "postgres://postgres:postgres@localhost:5433/club"; $env:TEST_PG_JIT_URL = "postgres://club_jit:jit-pw-1@localhost:5433/club"; pnpm --filter @kesher/api exec vitest run src/cards/jit.pg.test.ts
9. docker rm -f kesher-pg
Expected: step 6 prints `ok` for every schema (ledger 0028, billing 0006 and audit 0002 applied). Step 8 reports all tests passed: the privilege matrix equals the table in the test, an authorisation approves with every statement run as club_jit, an unknown card is declined, and each of the six forbidden statements is refused with SQLSTATE 42501.
Report back: the console output of steps 6 and 8 (the vitest summary), and `docker --version`. A grant that is missing shows as a body mismatch (DECLINED TIMEOUT), not an error line: report which test failed and the Postgres log (`docker logs kesher-pg`), which names the table and privilege.

## Result
PASS (2026-11-06 16:10 Asia/Jerusalem, desktop checker, runner worktree at e708f78). `docker --version`: Docker version 29.9.2, build a82e528.
- Steps 1-5: container up; `db/roles.sql` applied with ON_ERROR_STOP (exit 0); club_jit password and CONNECT set.
- Step 6: the first run's console output was lost to a bridge timeout; it completed: `atlas_*_schema_revisions` show ledger 0028, billing 0006, audit 0002. A re-run printed `No migration files to execute` per schema and `ok` for ledger, identity, org, billing, legal, addons, notify, audit, agent.
- Step 7: `pnpm install --frozen-lockfile` done in 5.3s.
- Step 8: `src/cards/jit.pg.test.ts (9 tests)` all passed, `Test Files 1 passed (1)`, `Tests 9 passed (9)`, including "holds exactly the owner-approved privileges on every table and sequence, and no DELETE anywhere".
- Step 9: `kesher-pg` removed.
