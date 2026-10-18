Task: T-0510 · Branch: claude/practical-babbage-80xevv · Needs: docker
Why: Migration ledger/0011 creates ops.payee (one row per member and bank account, with first_settled_at for the cooling-off rule); the cloud session only has PGlite, so the real Postgres 16 apply, the constraint check and the re-run go on the PC.
Steps (from repo root, PowerShell on Windows unless stated):
1. docker run --name kesher-pg -e POSTGRES_PASSWORD=postgres -e POSTGRES_DB=club -p 5433:5432 -d postgres:16
2. Start-Sleep -Seconds 8
3. Get-Content -Raw db/roles.sql | docker exec -i kesher-pg psql -U postgres -d club -v ON_ERROR_STOP=1
4. node db/migrate.mjs --docker --url "postgres://postgres:postgres@localhost:5433/club?sslmode=disable"
5. node db/migrate.mjs --docker --url "postgres://postgres:postgres@localhost:5433/club?sslmode=disable"
6. docker exec -i kesher-pg psql -U postgres -d club -c "\d ops.payee"
7. docker exec -i kesher-pg psql -U postgres -d club -c "set role club_app; insert into ops.payee (id, party_id, iban, iban_last4, name, validated_at, created_at) values (gen_random_uuid(), '00000000-0000-7000-8000-00000000a510', 'IL620108000000099999999', '9999', 'Handoff Check', now(), now()); insert into ops.payee (id, party_id, iban, iban_last4, name, validated_at, created_at) values (gen_random_uuid(), '00000000-0000-7000-8000-00000000a510', 'IL620108000000099999999', '9999', 'Handoff Check Again', now(), now())"
8. docker exec -i kesher-pg psql -U postgres -d club -c "\dp ops.payee"
9. docker rm -f kesher-pg
Expected: step 4 prints `ok   ledger` (11 migrations) then identity, org, billing, legal, addons, notify, audit, agent. Step 5 reports no pending migrations for every schema. Step 6 lists ops.payee with the unique index on (party_id, iban) and the party_id index. Step 7's second insert fails with a unique constraint violation on payee_party_id_iban_key (the first insert succeeds). Step 8 shows club_app with `arw` on ops.payee.
Report back: the console output of steps 4, 6, 7 and 8.

## Result
Date: 2026-10-18 10:30 Asia/Jerusalem (desktop checker, on Zvi's request)
Outcome: PASS
Ran at f1fe214 in one postgres:16 container shared by T-0503/T-0505/T-0507/T-0510 (steps 1-5 are identical; steps 1-5 run once, then each card's checks).
- Step 3 roles.sql: DO, DO, REVOKE, ALTER ROLE x7, ALTER DEFAULT PRIVILEGES.
- Step 4: ledger "Migrating to version 0011 (11 migrations in total)" ... "-- 11 migrations / 79 sql statements", then `ok   ledger`, `ok   identity`, `ok   org`, `ok   billing`, `ok   legal`, `ok   addons`, `ok   notify`, `ok   audit`, `ok   agent` (rc=0).
- Step 5 re-run: "No migration files to execute" x9, all ok (rc=0).
- Step 6: ops.payee with UNIQUE payee_party_id_iban_key (party_id, iban) and payee_party_id_created_at_idx (party_id, created_at DESC). As expected.
- Step 7: first insert `INSERT 0 1`, second `ERROR: duplicate key value violates unique constraint "payee_party_id_iban_key"`. As expected. (Both are in one psql -c transaction, so neither row persists; that doesn't affect the check.)
- Step 8: `club_app=arw/postgres` on ops.payee. As expected.
