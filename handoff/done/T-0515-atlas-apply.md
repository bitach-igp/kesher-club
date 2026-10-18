Task: T-0515 · Branch: claude/practical-babbage-80xevv · Needs: docker
Why: Migration ledger/0014 adds the received leg of a cross-currency send to ops.transfer (received_minor, received_currency, fx_rate_id, fx_rate_version, fx_rate_scaled, fx_markup_bps) with a NOT VALID check that the six are all null or all set, and a NOT VALID foreign key to ops.fx_rate; the cloud session only has PGlite, so the real Postgres 16 apply, the constraint checks and the re-run go on the PC. Each statement whose success another depends on is in its own `-c` call.
Steps (from repo root, PowerShell on Windows unless stated):
1. docker run --name kesher-pg -e POSTGRES_PASSWORD=postgres -e POSTGRES_DB=club -p 5433:5432 -d postgres:16
2. Start-Sleep -Seconds 8
3. Get-Content -Raw db/roles.sql | docker exec -i kesher-pg psql -U postgres -d club -v ON_ERROR_STOP=1
4. node db/migrate.mjs --docker --url "postgres://postgres:postgres@localhost:5433/club?sslmode=disable"
5. node db/migrate.mjs --docker --url "postgres://postgres:postgres@localhost:5433/club?sslmode=disable"
6. docker exec -i kesher-pg psql -U postgres -d club -c "\d ops.transfer"
7. docker exec -i kesher-pg psql -U postgres -d club -c "set role club_app; insert into ops.fx_rate (id, pair, version, mid_scaled, source, status, valid_from, valid_until, proposed_by) values ('00000000-0000-7000-8000-00000000f515', 'USD/ILS', 1, 3700000, 'port', 'active', now(), now() + interval '15 minutes', 'worker')"
8. docker exec -i kesher-pg psql -U postgres -d club -c "set role club_app; insert into ops.transfer (id, idempotency_key, kind, from_party_id, to_party_id, amount_minor, currency, state, received_minor, received_currency, fx_rate_id, fx_rate_version, fx_rate_scaled, fx_markup_bps) values (gen_random_uuid(), 'handoff-t0515-converted', 'p2p', '00000000-0000-7000-8000-00000000a515', '00000000-0000-7000-8000-00000000b515', 10000, 'USD', 'created', 36722, 'ILS', '00000000-0000-7000-8000-00000000f515', 1, 3700000, 75)"
9. docker exec -i kesher-pg psql -U postgres -d club -c "set role club_app; insert into ops.transfer (id, idempotency_key, kind, from_party_id, to_party_id, amount_minor, currency, state) values (gen_random_uuid(), 'handoff-t0515-plain', 'p2p', '00000000-0000-7000-8000-00000000a515', '00000000-0000-7000-8000-00000000b515', 10000, 'USD', 'created')"
10. docker exec -i kesher-pg psql -U postgres -d club -c "set role club_app; insert into ops.transfer (id, idempotency_key, kind, from_party_id, to_party_id, amount_minor, currency, state, received_minor, received_currency) values (gen_random_uuid(), 'handoff-t0515-half', 'p2p', '00000000-0000-7000-8000-00000000a515', '00000000-0000-7000-8000-00000000b515', 10000, 'USD', 'created', 36722, 'ILS')"
11. docker exec -i kesher-pg psql -U postgres -d club -c "set role club_app; insert into ops.transfer (id, idempotency_key, kind, from_party_id, to_party_id, amount_minor, currency, state, received_minor, received_currency, fx_rate_id, fx_rate_version, fx_rate_scaled, fx_markup_bps) values (gen_random_uuid(), 'handoff-t0515-same-ccy', 'p2p', '00000000-0000-7000-8000-00000000a515', '00000000-0000-7000-8000-00000000b515', 10000, 'USD', 'created', 10000, 'USD', '00000000-0000-7000-8000-00000000f515', 1, 1000000, 0)"
12. docker exec -i kesher-pg psql -U postgres -d club -c "set role club_app; insert into ops.transfer (id, idempotency_key, kind, from_party_id, to_party_id, amount_minor, currency, state, received_minor, received_currency, fx_rate_id, fx_rate_version, fx_rate_scaled, fx_markup_bps) values (gen_random_uuid(), 'handoff-t0515-no-rate', 'p2p', '00000000-0000-7000-8000-00000000a515', '00000000-0000-7000-8000-00000000b515', 10000, 'USD', 'created', 36722, 'ILS', '00000000-0000-7000-8000-00000000d515', 9, 3700000, 75)"
13. docker rm -f kesher-pg
Expected: step 4 prints `ok   ledger` (14 migrations) then identity (2), org, billing, legal, addons, notify, audit, agent. Step 5 reports no pending migrations for every schema. Step 6 lists ops.transfer with the six new nullable columns, the check transfer_received_check and the foreign key transfer_fx_rate_fk to ops.fx_rate(id). Step 7 prints `INSERT 0 1`. Step 8 prints `INSERT 0 1` (a fully priced conversion). Step 9 prints `INSERT 0 1` (a same-currency send, all six null). Step 10 fails with a check constraint violation on transfer_received_check (half a conversion). Step 11 fails with the same check (received in the sent currency). Step 12 fails with a foreign key violation on transfer_fx_rate_fk (a rate row that does not exist).
Report back: the console output of steps 4, 6, 8, 9, 10, 11 and 12.

## Result
Date: 2026-10-18 21:07 Asia/Jerusalem (desktop checker)
Outcome: PASS, run at 0dbaaa2 in a fresh postgres:16 container.
- Step 4: ledger "Migrating to version 0014 (14 migrations in total)", "-- 14 migrations"; identity 2 migrations; then `ok` for ledger, identity, org, billing, legal, addons, notify, audit, agent.
- Step 5 re-run: no pending migrations, all ok.
- Step 6: ops.transfer has nullable received_minor bigint, received_currency ledger.currency, fx_rate_id uuid, fx_rate_version integer, fx_rate_scaled bigint, fx_markup_bps integer; `"transfer_received_check" CHECK (...) NOT VALID`; `"transfer_fx_rate_fk" FOREIGN KEY (fx_rate_id) REFERENCES ops.fx_rate(id) NOT VALID`. As expected.
- Step 7: `INSERT 0 1`.
- Step 8: `INSERT 0 1` (priced conversion). As expected.
- Step 9: `INSERT 0 1` (same-currency, all six null). As expected.
- Step 10: `ERROR: new row for relation "transfer" violates check constraint "transfer_received_check"`. As expected.
- Step 11: `ERROR: new row for relation "transfer" violates check constraint "transfer_received_check"`. As expected.
- Step 12: `ERROR: insert or update on table "transfer" violates foreign key constraint "transfer_fx_rate_fk"` (Key (fx_rate_id)=(...d515) is not present in table "fx_rate"). As expected.
- Step 13: container removed.
