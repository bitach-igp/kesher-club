Task: T-0507 · Branch: claude/practical-babbage-80xevv · Needs: docker
Why: Migration ledger/0010 creates ops.payment_request (requests and splits, referencing ops.transfer); the cloud session only has PGlite, so the real Postgres 16 apply, the constraint checks and the re-run go on the PC.
Steps (from repo root, PowerShell on Windows unless stated):
1. docker run --name kesher-pg -e POSTGRES_PASSWORD=postgres -e POSTGRES_DB=club -p 5433:5432 -d postgres:16
2. Start-Sleep -Seconds 8
3. Get-Content -Raw db/roles.sql | docker exec -i kesher-pg psql -U postgres -d club -v ON_ERROR_STOP=1
4. node db/migrate.mjs --docker --url "postgres://postgres:postgres@localhost:5433/club?sslmode=disable"
5. node db/migrate.mjs --docker --url "postgres://postgres:postgres@localhost:5433/club?sslmode=disable"
6. docker exec -i kesher-pg psql -U postgres -d club -c "\d ops.payment_request"
7. docker exec -i kesher-pg psql -U postgres -d club -c "set role club_app; insert into ops.payment_request (id, idempotency_key, requester_party_id, payer_party_id, amount_minor, currency, status, created_at, expires_at, updated_at) values (gen_random_uuid(), 'handoff-507', '00000000-0000-7000-8000-00000000a507', '00000000-0000-7000-8000-00000000b507', 0, 'ILS', 'open', now(), now() + interval '14 days', now())"
8. docker exec -i kesher-pg psql -U postgres -d club -c "set role club_app; insert into ops.payment_request (id, idempotency_key, requester_party_id, payer_party_id, amount_minor, currency, status, created_at, expires_at, updated_at) values (gen_random_uuid(), 'handoff-507', '00000000-0000-7000-8000-00000000a507', '00000000-0000-7000-8000-00000000b507', 5000, 'ILS', 'pending', now(), now() + interval '14 days', now())"
9. docker exec -i kesher-pg psql -U postgres -d club -c "\dp ops.payment_request"
10. docker rm -f kesher-pg
Expected: step 4 prints `ok   ledger` (10 migrations) then identity, org, billing, legal, addons, notify, audit, agent. Step 5 reports no pending migrations for every schema. Step 6 lists ops.payment_request with the amount and status checks, a unique index on idempotency_key, the payer, requester and partial expires_at indexes. Step 7 fails with a check constraint violation on payment_request_amount_minor_check. Step 8 fails with a check constraint violation on payment_request_status_check. Step 9 shows club_app with `arw` on ops.payment_request.
Report back: the console output of steps 4, 6, 7, 8 and 9.
