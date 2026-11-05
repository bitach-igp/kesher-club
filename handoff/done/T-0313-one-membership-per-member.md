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

## Result
PASS for the migration and the index; the race test needed one fix (pushed as a separate commit). 2026-11-05 04:05-04:25 Asia/Jerusalem, runner worktree on Zvi's PC at 34b479f, then re-run with the fix.
- `docker --version`: Docker version 29.9.2, build a82e528
- Step 4: `ok` for all nine schemas (ledger, identity, org, billing, legal, addons, notify, audit, agent); `membership_one_open_per_member` present in billing.
- Step 6 at 34b479f: first fresh-DB run `Tests 1 passed (1)`; a second fresh-DB run failed `expected "cancel" to be called 4 times, but got 0 times` (all four losers were refused by the early `held` check before any vendor call, a correct outcome the test did not allow). With the fix commit: two fresh-DB runs `Tests 1 passed (1)`, 5 subscriptions made, 4 cancelled.
- Step 7: fails as expected: `ERROR:  duplicate key value violates unique constraint "membership_one_open_per_member"` / `DETAIL:  Key (member_party_id)=(...) already exists.`
- Step 8: container removed.
- Note: the pg test passes only on a fresh database. Re-running it on the same database fails (all five creates refused) because each run's new `SimulatorHost` numbers subscriptions from `sub_000001` again and `ops.external_ref` has primary key (provider, external_id), so the winner's ref insert collides with a previous run's and is treated as a lost race.
