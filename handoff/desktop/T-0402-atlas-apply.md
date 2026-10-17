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
