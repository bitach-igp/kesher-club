Task: T-0306 · Branch: claude/practical-babbage-80xevv · Needs: docker
Why: Migration billing/0003 adds billing.funder_invite, where a funder's invite to a member waits until it is accepted (REQ-BIL-002); the app role may create and update an invite but never delete one, and a funder has one open invite per contact. This applies it on real Postgres 16 and checks the one-open-invite rule and the missing delete grant. Each statement whose success another depends on is in its own `-c` call; steps 8 and 9 are meant to fail. Nothing here is real data.
Steps (from repo root, PowerShell on Windows unless stated):
1. $OutputEncoding = New-Object System.Text.UTF8Encoding $false
2. docker run --name kesher-pg -e POSTGRES_PASSWORD=postgres -e POSTGRES_DB=club -p 5433:5432 -d postgres:16
3. Start-Sleep -Seconds 8
4. Get-Content -Raw db/roles.sql | docker exec -i kesher-pg psql -U postgres -d club -v ON_ERROR_STOP=1
5. node db/migrate.mjs --docker --url "postgres://postgres:postgres@localhost:5433/club?sslmode=disable"
6. docker exec -i kesher-pg psql -U postgres -d club -c "insert into billing.plan (code, name) values ('t0306-check', 'Handoff check')" -c "insert into billing.plan_version (plan_code, version, price_minor, currency, term_months, effective_from) values ('t0306-check', 1, 4900, 'USD', 10, now())"
7. docker exec -i kesher-pg psql -U postgres -d club -c "set role club_app; insert into billing.funder_invite (id, idempotency_key, funder_party_id, member_name, contact_kind, contact, plan_code, plan_version, token_hash, status, expires_at, last_sent_at, created_at) values ('00000000-0000-7000-8000-000000030601', 't0306-a', '00000000-0000-7000-8000-0000000306f0', 'Dana Example', 'phone', '+15555550101', 't0306-check', 1, 'hash-a', 'open', now() + interval '7 days', now(), now())"
8. docker exec -i kesher-pg psql -U postgres -d club -c "set role club_app; insert into billing.funder_invite (id, idempotency_key, funder_party_id, member_name, contact_kind, contact, plan_code, plan_version, token_hash, status, expires_at, last_sent_at, created_at) values ('00000000-0000-7000-8000-000000030602', 't0306-b', '00000000-0000-7000-8000-0000000306f0', 'Dana Example', 'phone', '+15555550101', 't0306-check', 1, 'hash-b', 'open', now() + interval '7 days', now(), now())"
9. docker exec -i kesher-pg psql -U postgres -d club -c "set role club_app; delete from billing.funder_invite"
10. docker exec -i kesher-pg psql -U postgres -d club -c "set role club_app; update billing.funder_invite set status = 'cancelled' where id = '00000000-0000-7000-8000-000000030601'" -c "select status from billing.funder_invite"
11. docker rm -f kesher-pg
Expected: step 5 prints `ok` for every schema, with billing at 3 migrations. Step 6 prints `INSERT 0 1` twice; step 7 `SET` then `INSERT 0 1`. Step 8 prints `SET` then `ERROR:  duplicate key value violates unique constraint "funder_invite_one_open"`. Step 9 prints `SET` then `ERROR:  permission denied for table funder_invite`. Step 10 prints `SET`, `UPDATE 1`, then one row: `cancelled`.
Report back: the console output of steps 5 to 10.
