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
Report back: the console output of steps 6 and 8 (the vitest summary), and `docker --version`. If a statement is refused with 42501 that the approval path needs, give the table and privilege from the error line.
