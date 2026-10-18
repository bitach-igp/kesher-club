Task: T-0505 · Branch: claude/practical-babbage-80xevv · Needs: docker
Why: Migration ledger/0009 creates ops.risk_limit (seeded per tier and currency) and ops.risk_tier; the cloud session only has PGlite, so the real Postgres 16 apply, the seed check and the re-run go on the PC.
Steps (from repo root, PowerShell on Windows unless stated):
1. docker run --name kesher-pg -e POSTGRES_PASSWORD=postgres -e POSTGRES_DB=club -p 5433:5432 -d postgres:16
2. Start-Sleep -Seconds 8
3. Get-Content -Raw db/roles.sql | docker exec -i kesher-pg psql -U postgres -d club -v ON_ERROR_STOP=1
4. node db/migrate.mjs --docker --url "postgres://postgres:postgres@localhost:5433/club?sslmode=disable"
5. node db/migrate.mjs --docker --url "postgres://postgres:postgres@localhost:5433/club?sslmode=disable"
6. docker exec -i kesher-pg psql -U postgres -d club -c "select tier, currency, p2p_monthly_minor from ops.risk_limit order by 1, 2"
7. docker exec -i kesher-pg psql -U postgres -d club -c "\d ops.risk_tier"
8. docker exec -i kesher-pg psql -U postgres -d club -c "set role club_app; insert into ops.risk_tier (party_id, tier, set_by, reason) values ('00000000-0000-7000-8000-00000000b505', 'platinum', 'handoff', 'check')"
9. docker exec -i kesher-pg psql -U postgres -d club -c "set role club_app; update ops.risk_limit set p2p_monthly_minor = 1 where tier = 'new'"
10. docker rm -f kesher-pg
Expected: step 4 prints `ok   ledger` (9 migrations) then identity, org, billing, legal, addons, notify, audit, agent. Step 5 reports no pending migrations for every schema. Step 6 lists six rows: new ILS 100000 / USD 30000, standard ILS 500000 / USD 150000, trusted ILS 2000000 / USD 600000. Step 7 lists ops.risk_tier with the tier check and party_id as the primary key. Step 8 fails with a check constraint violation on risk_tier_tier_check. Step 9 fails with permission denied for table risk_limit (the app role only reads limits).
Report back: the console output of steps 4, 6, 7, 8 and 9.
