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

## Result
Date: 2026-10-18 10:30 Asia/Jerusalem (desktop checker, on Zvi's request)
Outcome: PASS
Ran at f1fe214 in one postgres:16 container shared by T-0503/T-0505/T-0507/T-0510 (steps 1-5 are identical; steps 1-5 run once, then each card's checks).
- Step 3 roles.sql: DO, DO, REVOKE, ALTER ROLE x7, ALTER DEFAULT PRIVILEGES.
- Step 4: ledger "Migrating to version 0011 (11 migrations in total)" ... "-- 11 migrations / 79 sql statements", then `ok   ledger`, `ok   identity`, `ok   org`, `ok   billing`, `ok   legal`, `ok   addons`, `ok   notify`, `ok   audit`, `ok   agent` (rc=0).
- Step 5 re-run: "No migration files to execute" x9, all ok (rc=0).
- Step 6: ops.payment_request with payment_request_amount_minor_check (amount_minor > 0), payment_request_status_check (open, paid, declined, expired, cancelled), UNIQUE payment_request_idempotency_key_key, payer (payer_party_id, status, created_at DESC) and requester (requester_party_id, created_at DESC) indexes, partial payment_request_expires_at_idx WHERE status = 'open', FK transfer_id to ops.transfer. As expected.
- Step 7: `ERROR: ... violates check constraint "payment_request_amount_minor_check"`. As expected.
- Step 8: `ERROR: ... violates check constraint "payment_request_status_check"`. As expected.
- Step 9: `club_app=arw/postgres` on ops.payment_request. As expected.
