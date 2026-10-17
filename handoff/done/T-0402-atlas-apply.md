Task: T-0402 · Branch: claude/practical-babbage-80xevv · Needs: docker
Why: ledger/0007 creates the cards schema (cards.card, cards.card_token) with read-only grants for club_jit; the cloud session only has PGlite, so the real Postgres 16 apply, the grant check and the re-run go on the PC.
Steps (from repo root, PowerShell on Windows unless stated):
1. docker run --name kesher-pg -e POSTGRES_PASSWORD=postgres -e POSTGRES_DB=club -p 5433:5432 -d postgres:16
2. Start-Sleep -Seconds 8
3. Get-Content -Raw db/roles.sql | docker exec -i kesher-pg psql -U postgres -d club -v ON_ERROR_STOP=1
4. node db/migrate.mjs --docker --url "postgres://postgres:postgres@localhost:5433/club?sslmode=disable"
5. node db/migrate.mjs --docker --url "postgres://postgres:postgres@localhost:5433/club?sslmode=disable"
6. docker exec -i kesher-pg psql -U postgres -d club -c "select schemaname, count(*) as tables from pg_tables where schemaname in ('ledger','ops','cards','identity','agent','billing','legal','org','addons','notify','audit') group by 1 order by 1"
7. docker exec -i kesher-pg psql -U postgres -d club -c "\d cards.card"
8. docker exec -i kesher-pg psql -U postgres -d club -c "\dp cards.*"
9. docker exec -i kesher-pg psql -U postgres -d club -c "set role club_jit; insert into cards.card_token (token_id, card_id, wallet, device_id, status) values ('x', gen_random_uuid(), 'apple', 'd', 'active')"
10. docker rm -f kesher-pg
Expected: step 4 prints `ok   ledger` (7 migrations) then identity, org, billing, legal, addons, notify, audit, agent. Step 5 reports no pending migrations for every schema. Step 6 shows cards with 2 tables. Step 7 lists cards.card with no column for a PAN, CVV or expiry (last4 only) and unique constraints on processor_card_id and workflow_id. Step 8 shows club_app with `arw` and club_jit with `r` on both tables. Step 9 fails with permission denied for table card_token (club_jit never writes).
Report back: the console output of steps 4, 6, 7, 8 and 9.

## Result
PASS — run 2026-10-18 00:06 (Asia/Jerusalem) by the desktop checker on Zvi's PC (Windows, Docker 29.8.2, postgres:16), runner worktree detached at 1a72e98 (branch head; includes ledger/0006 T-0908, identity/0001 T-0401 and ledger/0007 T-0402). One container served the T-0401, T-0402 and T-0908 requests; steps 1-5 are identical in all three.
- Steps 1–3: container up; roles.sql applied (exit 0).
- Step 4: `ok   ledger`, `ok   identity`, `ok   org`, `ok   billing`, `ok   legal`, `ok   addons`, `ok   notify`, `ok   audit`, `ok   agent`, exit 0. atlas_ledger revisions 0001–0007.
- Step 5: "No migration files to execute" and `ok` for every schema, exit 0.
- Table counts: addons 4, agent 4, audit 1, billing 5, cards 2, identity 1, ledger 3, legal 2, notify 3, ops 12, org 12.
- Step 6: cards 2 tables.
- Step 7 (`\d cards.card`): no PAN/CVV/expiry column, last4 only (check `^[0-9A-Za-z_]{4}$`); UNIQUE card_processor_card_id_key and card_workflow_id_key.
- Step 8 (`\dp cards.*`): card and card_token each `club_app=arw/postgres`, `club_jit=r/postgres`.
- Step 9: `ERROR: permission denied for table card_token`, exit 1 (expected); card_token row count 0.
- Step 10: container removed.
