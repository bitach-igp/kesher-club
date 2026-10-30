Task: T-0928 · Branch: claude/practical-babbage-80xevv · Needs: docker
Why: The first T-0928 apply (handoff/done/T-0928-atlas-apply.md, PASS at 92c0f7e) ran migration addons/0003 when it granted the app update on the whole price_rule table. Commit 1c8918a narrowed that grant before merge: the app may insert a rule and update only its state columns (active, approval_id, activated_at, rejected_at), never a rule's pricing terms, and never delete one. This re-applies the revised migration on real Postgres 16 and checks the narrower grant. Each statement whose success another depends on is in its own `-c` call. Nothing here is a real price.
Steps (from repo root, PowerShell on Windows unless stated):
1. docker run --name kesher-pg -e POSTGRES_PASSWORD=postgres -e POSTGRES_DB=club -p 5433:5432 -d postgres:16
2. Start-Sleep -Seconds 8
3. Get-Content -Raw db/roles.sql | docker exec -i kesher-pg psql -U postgres -d club -v ON_ERROR_STOP=1
4. node db/migrate.mjs --docker --url "postgres://postgres:postgres@localhost:5433/club?sslmode=disable"
5. docker exec -i kesher-pg psql -U postgres -d club -c "set role club_app; insert into addons.price_rule (id, kind, provider, sku_pattern, margin_bps, floor_minor, currency, round_to_99, priority, active, proposed_by, reason) values ('00000000-0000-7000-8000-000000092810', 'esim', 'simulator', '^IL-', 2500, 0, 'USD', true, 10, false, 'finance-a', 'T-0928 recheck')"
6. docker exec -i kesher-pg psql -U postgres -d club -c "set role club_app; update addons.price_rule set active = true, activated_at = now() where id = '00000000-0000-7000-8000-000000092810'"
7. docker exec -i kesher-pg psql -U postgres -d club -c "set role club_app; update addons.price_rule set margin_bps = 0"
8. docker exec -i kesher-pg psql -U postgres -d club -c "set role club_app; delete from addons.price_rule"
9. docker rm -f kesher-pg
Expected: step 4 prints `ok` for every schema, with addons at 3 migrations and ledger at 22. Step 5 prints `SET` then `INSERT 0 1`; step 6 `SET` then `UPDATE 1`. Step 7 fails with `permission denied for table price_rule` (pricing terms are not the app's to change), and so does step 8.
Report back: the console output of steps 4 to 8.

## Result
PASS, 2026-10-30 12:20 (Asia/Jerusalem), Kesher desktop checker on the Windows PC, runner worktree at e08dc3c, Docker 29.8.2, postgres:16.
- Step 3: roles applied (ALTER ROLE).
- Step 4: `ok` for all nine schemas (ledger, identity, org, billing, legal, addons, notify, audit, agent); ledger 22 migrations, identity 4, org 7, addons 3, agent 2.
- Step 5: `SET` / `INSERT 0 1`.
- Step 6: `SET` / `UPDATE 1`.
- Step 7: `SET` / `ERROR:  permission denied for table price_rule`.
- Step 8: `SET` / `ERROR:  permission denied for table price_rule`.
- Step 9: container removed.
