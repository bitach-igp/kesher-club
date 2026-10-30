Task: T-0928 · Branch: claude/practical-babbage-80xevv · Needs: docker
Why: Migration addons/0003 lets the app write add-on price rules (insert and update, never delete) and adds who proposed a rule, why, its approval and when it was activated or rejected; ledger/0022 widens the approval kinds with 'price_rule' (NOT VALID, a superset of the list before). A proposal is a rule with active = false until a second finance member approves it. This needs the real Postgres 16 apply; the cloud session only has PGlite. Each statement whose success another depends on is in its own `-c` call. Nothing here is a real price.
Steps (from repo root, PowerShell on Windows unless stated):
1. docker run --name kesher-pg -e POSTGRES_PASSWORD=postgres -e POSTGRES_DB=club -p 5433:5432 -d postgres:16
2. Start-Sleep -Seconds 8
3. Get-Content -Raw db/roles.sql | docker exec -i kesher-pg psql -U postgres -d club -v ON_ERROR_STOP=1
4. node db/migrate.mjs --docker --url "postgres://postgres:postgres@localhost:5433/club?sslmode=disable"
5. node db/migrate.mjs --docker --url "postgres://postgres:postgres@localhost:5433/club?sslmode=disable"
6. docker exec -i kesher-pg psql -U postgres -d club -c "set role club_app; insert into addons.price_rule (id, kind, provider, sku_pattern, margin_bps, floor_minor, currency, round_to_99, priority, active, proposed_by, reason) values ('00000000-0000-7000-8000-000000092800', 'esim', 'simulator', '^IL-', 2500, 0, 'USD', true, 10, false, 'finance-a', 'T-0928 check')"
7. docker exec -i kesher-pg psql -U postgres -d club -c "set role club_app; update addons.price_rule set active = true, activated_at = now() where id = '00000000-0000-7000-8000-000000092800'"
8. docker exec -i kesher-pg psql -U postgres -d club -c "set role club_app; insert into ops.approval_request (id, kind, subject, payload, required, scope, requested_by, status, expires_at, created_at) values ('00000000-0000-7000-8000-000000092801', 'price_rule', 'price_rule:00000000-0000-7000-8000-000000092800', '{}', 2, 'platform', '00000000-0000-7000-8000-000000092899', 'awaiting_second_approval', now() + interval '7 days', now())"
9. docker exec -i kesher-pg psql -U postgres -d club -c "set role club_app; insert into addons.price_rule (id, kind, provider, sku_pattern, margin_bps, floor_minor, currency, priority, active) values ('00000000-0000-7000-8000-000000092802', 'esim', 'simulator', '.*', 25000, 0, 'USD', 10, false)"
10. docker exec -i kesher-pg psql -U postgres -d club -c "set role club_app; delete from addons.price_rule"
11. docker rm -f kesher-pg
Expected: step 4 prints `ok` for every schema, with addons at 3 migrations and ledger at 22. Step 5 reports no pending migrations. Step 6 prints `SET` then `INSERT 0 1`; step 7 `SET` then `UPDATE 1`; step 8 `SET` then `INSERT 0 1`. Step 9 fails with a check constraint violation (the margin is above 20,000 basis points). Step 10 fails with `permission denied for table price_rule`.
Report back: the console output of steps 4 to 10.
