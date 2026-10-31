Task: T-0310 · Branch: claude/practical-babbage-80xevv · Needs: docker
Why: Migration billing/0004 adds `cancel_at` to billing.membership, the date a membership the funder cancelled ends on (REQ-BIL-004). This applies it on real Postgres 16 and checks that the app role can set it on an existing membership. Each statement whose success another depends on is in its own `-c` call. Nothing here is real data.
Steps (from repo root, PowerShell on Windows unless stated):
1. $OutputEncoding = New-Object System.Text.UTF8Encoding $false
2. docker run --name kesher-pg -e POSTGRES_PASSWORD=postgres -e POSTGRES_DB=club -p 5433:5432 -d postgres:16
3. Start-Sleep -Seconds 8
4. Get-Content -Raw db/roles.sql | docker exec -i kesher-pg psql -U postgres -d club -v ON_ERROR_STOP=1
5. node db/migrate.mjs --docker --url "postgres://postgres:postgres@localhost:5433/club?sslmode=disable"
6. docker exec -i kesher-pg psql -U postgres -d club -c "insert into billing.plan (code, name) values ('t0310-check', 'Handoff check')" -c "insert into billing.plan_version (plan_code, version, price_minor, currency, term_months, effective_from) values ('t0310-check', 1, 4900, 'USD', 10, now())" -c "insert into billing.membership (id, idempotency_key, member_party_id, funder_party_id, plan_code, plan_version, status, term_months, price_minor, currency) values ('00000000-0000-7000-8000-000000031001', 't0310-check', '00000000-0000-7000-8000-0000000310a0', '00000000-0000-7000-8000-0000000310b0', 't0310-check', 1, 'active', 10, 4900, 'USD')"
7. docker exec -i kesher-pg psql -U postgres -d club -c "set role club_app; update billing.membership set cancel_at = '2027-07-31T00:00:00Z' where id = '00000000-0000-7000-8000-000000031001'"
8. docker exec -i kesher-pg psql -U postgres -d club -c "select status, cancel_at from billing.membership where id = '00000000-0000-7000-8000-000000031001'"
9. docker rm -f kesher-pg
Expected: step 5 prints `ok` for every schema, with billing at 4 migrations. Step 6 prints `INSERT 0 1` three times; step 7 `SET` then `UPDATE 1`; step 8 one row: `active | 2027-07-31 00:00:00+00`.
Report back: the console output of steps 5 to 8.

## Result
PASS (2026-10-31 23:10 Asia/Jerusalem), runner at 2e87809, Docker 29.8.2, postgres:16, fresh container, removed after.
- Step 4 (roles): DO / DO / REVOKE / ALTER ROLE / ALTER DEFAULT PRIVILEGES / ALTER ROLE x6.
- Step 5: `ok` for all 9 schemas (ledger 25, identity 4, org 8, billing 4, legal 1, addons 3, notify 1, audit 1, agent 2 migrations).
- Step 6: `INSERT 0 1` three times.
- Step 7: `SET`, `UPDATE 1`.
- Step 8: `active | 2027-07-31 00:00:00+00` (1 row).
- Step 9: `kesher-pg` removed.
