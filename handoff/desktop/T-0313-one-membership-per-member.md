Task: T-0313 · Branch: card/T-0313 · Needs: docker
Why: the partial unique index (billing migration 0005) and its race (five simultaneous creates for one member) can only be shown with several real connections; PGlite is one connection. The migration is applied here to prove it runs on real Postgres 16.
Steps (from repo root, PowerShell on Windows unless stated):
1. docker run --name kesher-pg -e POSTGRES_PASSWORD=postgres -e POSTGRES_DB=club -p 5433:5432 -d postgres:16
2. Start-Sleep -Seconds 8
3. Get-Content -Raw db/roles.sql | docker exec -i kesher-pg psql -U postgres -d club -v ON_ERROR_STOP=1
4. node db/migrate.mjs --docker --url "postgres://postgres:postgres@localhost:5433/club?sslmode=disable"
5. pnpm install --frozen-lockfile
6. $env:TEST_PG_URL = "postgres://postgres:postgres@localhost:5433/club"; pnpm --filter @kesher/api exec vitest run src/billing/memberships.pg.test.ts
7. docker exec kesher-pg psql -U postgres -d club -c "insert into billing.membership (id, idempotency_key, member_party_id, funder_party_id, plan_code, plan_version, status, term_months, price_minor, currency) select gen_random_uuid(), 'dup-check-1', member_party_id, funder_party_id, plan_code, plan_version, 'active', term_months, price_minor, currency from billing.membership limit 1"
8. docker rm -f kesher-pg
Expected: step 4 prints `ok` for every schema including billing (0005 applied). Step 6 reports 1 test passed: of five simultaneous creates for one member exactly one succeeds, the other four are refused IDEMPOTENCY_CONFLICT, one row exists and four subscriptions were ended. Step 7 is run after step 6 and must FAIL with `duplicate key value violates unique constraint "membership_one_open_per_member"` (a second open membership for the member step 6 left behind).
Report back: the console output of steps 4, 6 and 7 (the vitest summary and the step 7 error line), and `docker --version`.
