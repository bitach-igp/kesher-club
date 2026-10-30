Task: T-0932 · Branch: claude/practical-babbage-80xevv · Needs: docker
Why: Migration billing/0002 gives billing.plan_version a state (proposed, active, rejected), its market, proposer, reason, approval and decision time, and lets the app role create plans and versions and set only the decision columns; ledger/0025 adds the `plan_version` approval kind (REQ-ADM-006). This applies both on real Postgres 16 and checks that the app role can propose and approve a version but can never change its price. Each statement whose success another depends on is in its own `-c` call; the last one is meant to fail. Nothing here is real data.
Steps (from repo root, PowerShell on Windows unless stated):
1. docker run --name kesher-pg -e POSTGRES_PASSWORD=postgres -e POSTGRES_DB=club -p 5433:5432 -d postgres:16
2. Start-Sleep -Seconds 8
3. Get-Content -Raw db/roles.sql | docker exec -i kesher-pg psql -U postgres -d club -v ON_ERROR_STOP=1
4. node db/migrate.mjs --docker --url "postgres://postgres:postgres@localhost:5433/club?sslmode=disable"
5. docker exec -i kesher-pg psql -U postgres -d club -c "set role club_app; insert into billing.plan (code, name) values ('t0932-check', 'Handoff check')"
6. docker exec -i kesher-pg psql -U postgres -d club -c "set role club_app; insert into billing.plan_version (plan_code, version, price_minor, currency, term_months, effective_from, state, market, proposed_by, reason) values ('t0932-check', 1, 18000, 'ILS', 10, now(), 'proposed', 'IL', 'finance-a', 'handoff check')"
7. docker exec -i kesher-pg psql -U postgres -d club -c "set role club_app; update billing.plan_version set state = 'active', decided_at = now() where plan_code = 't0932-check' and version = 1"
8. docker exec -i kesher-pg psql -U postgres -d club -c "select plan_code, version, state, market from billing.plan_version where plan_code = 't0932-check'"
9. docker exec -i kesher-pg psql -U postgres -d club -c "set role club_app; update billing.plan_version set price_minor = 1 where plan_code = 't0932-check'"
10. docker rm -f kesher-pg
Expected: step 4 prints `ok` for every schema, with ledger at 25 migrations and billing at 2. Steps 5 and 6 print `SET` then `INSERT 0 1`; step 7 `SET` then `UPDATE 1`; step 8 one row: `t0932-check | 1 | active | IL`. Step 9 prints `SET` then `ERROR:  permission denied for table plan_version`.
Report back: the console output of steps 4 to 9.
