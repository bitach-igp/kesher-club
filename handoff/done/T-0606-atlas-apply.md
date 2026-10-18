Task: T-0606 · Branch: claude/practical-babbage-80xevv · Needs: docker
Why: Migration ledger/0012 widens the ops.transfer kind check to allow 'fee' (a member paying an institution's fee item is now a transfer) and adds a partial index on ops.case for the monitoring job; the cloud session only has PGlite, so the real Postgres 16 apply, the constraint check and the re-run go on the PC. Dependent statements are in their own `-c` calls so one failing insert cannot roll back another.
Steps (from repo root, PowerShell on Windows unless stated):
1. docker run --name kesher-pg -e POSTGRES_PASSWORD=postgres -e POSTGRES_DB=club -p 5433:5432 -d postgres:16
2. Start-Sleep -Seconds 8
3. Get-Content -Raw db/roles.sql | docker exec -i kesher-pg psql -U postgres -d club -v ON_ERROR_STOP=1
4. node db/migrate.mjs --docker --url "postgres://postgres:postgres@localhost:5433/club?sslmode=disable"
5. node db/migrate.mjs --docker --url "postgres://postgres:postgres@localhost:5433/club?sslmode=disable"
6. docker exec -i kesher-pg psql -U postgres -d club -c "\d ops.transfer"
7. docker exec -i kesher-pg psql -U postgres -d club -c "set role club_app; insert into ops.transfer (id, idempotency_key, kind, from_party_id, amount_minor, currency, state) values (gen_random_uuid(), 'handoff-fee-1', 'fee', '00000000-0000-7000-8000-00000000a606', 12000, 'ILS', 'created')"
8. docker exec -i kesher-pg psql -U postgres -d club -c "set role club_app; insert into ops.transfer (id, idempotency_key, kind, from_party_id, amount_minor, currency, state) values (gen_random_uuid(), 'handoff-bogus-1', 'bogus', '00000000-0000-7000-8000-00000000a606', 12000, 'ILS', 'created')"
9. docker exec -i kesher-pg psql -U postgres -d club -c "\d ops.case"
10. docker rm -f kesher-pg
Expected: step 4 prints `ok   ledger` (12 migrations) then identity, org, billing, legal, addons, notify, audit, agent. Step 5 reports no pending migrations for every schema. Step 6 lists ops.transfer with the check constraint transfer_kind_check naming 'fee' among the kinds (shown NOT VALID). Step 7 prints `INSERT 0 1`. Step 8 fails with a check constraint violation on transfer_kind_check. Step 9 lists the partial index case_monitoring_party_idx on (kind, (payload ->> 'partyId')) WHERE kind = ANY ('structuring', 'velocity').
Report back: the console output of steps 4, 6, 7, 8 and 9.

## Result
Date: 2026-10-18 11:15 Asia/Jerusalem (desktop checker, on Zvi's request)
Outcome: PASS, run at 686090e in postgres:16.
- Step 3 roles.sql: DO, DO, REVOKE, ALTER ROLE x7, ALTER DEFAULT PRIVILEGES.
- Step 4: ledger "Migrating to version 0012 (12 migrations in total)". 0012 ran `alter table ops.transfer drop constraint transfer_kind_check`, `add constraint transfer_kind_check check (kind in ('p2p','load','payout','fx','allowance','addon','refund','fee')) not valid` and `create index case_monitoring_party_idx on ops.case (kind, (payload->>'partyId')) where kind in ('structuring','velocity')`, finishing with "-- ok (24.6ms)" and "-- 12 migrations". Then `ok   ledger`, `ok   identity`, `ok   org`, `ok   billing`, `ok   legal`, `ok   addons`, `ok   notify`, `ok   audit`, `ok   agent` (rc=0).
- Step 5 re-run: "No migration files to execute" x9, all ok (rc=0).
- Step 6: `"transfer_kind_check" CHECK (kind = ANY (ARRAY['p2p','load','payout','fx','allowance','addon','refund','fee'])) NOT VALID`. Other checks are unchanged: transfer_amount_minor_check, transfer_state_check. As expected.
- Step 7: `INSERT 0 1`. As expected.
- Step 8: `ERROR: new row for relation "transfer" violates check constraint "transfer_kind_check"`. As expected.
- Step 9: `"case_monitoring_party_idx" btree (kind, (payload ->> 'partyId'::text)) WHERE kind = ANY (ARRAY['structuring'::text, 'velocity'::text])`. As expected.
- Step 10: container removed.
