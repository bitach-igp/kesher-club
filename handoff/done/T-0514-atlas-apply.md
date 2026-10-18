Task: T-0514 · Branch: claude/practical-babbage-80xevv · Needs: docker
Why: Migration identity/0002 creates identity.member_preference (the receiving currency a member chose); the cloud session only has PGlite, so the real Postgres 16 apply, the constraint check and the re-run go on the PC. Each statement whose success another depends on is in its own `-c` call.
Steps (from repo root, PowerShell on Windows unless stated):
1. docker run --name kesher-pg -e POSTGRES_PASSWORD=postgres -e POSTGRES_DB=club -p 5433:5432 -d postgres:16
2. Start-Sleep -Seconds 8
3. Get-Content -Raw db/roles.sql | docker exec -i kesher-pg psql -U postgres -d club -v ON_ERROR_STOP=1
4. node db/migrate.mjs --docker --url "postgres://postgres:postgres@localhost:5433/club?sslmode=disable"
5. node db/migrate.mjs --docker --url "postgres://postgres:postgres@localhost:5433/club?sslmode=disable"
6. docker exec -i kesher-pg psql -U postgres -d club -c "\d identity.member_preference"
7. docker exec -i kesher-pg psql -U postgres -d club -c "set role club_app; insert into identity.member_preference (party_id, receive_currency) values ('00000000-0000-7000-8000-00000000a514', 'ILS')"
8. docker exec -i kesher-pg psql -U postgres -d club -c "set role club_app; insert into identity.member_preference (party_id, receive_currency) values ('00000000-0000-7000-8000-00000000b514', 'EUR')"
9. docker exec -i kesher-pg psql -U postgres -d club -c "\dp identity.member_preference"
10. docker rm -f kesher-pg
Expected: step 4 prints `ok   ledger` then `ok   identity` (2 migrations) and the other schemas. Step 5 reports no pending migrations for every schema. Step 6 lists identity.member_preference with the primary key on party_id and the check on receive_currency. Step 7 prints `INSERT 0 1`. Step 8 fails with a check constraint violation on member_preference_receive_currency_check. Step 9 shows club_app with `arw` on identity.member_preference.
Report back: the console output of steps 4, 6, 7, 8 and 9.

## Result
Date: 2026-10-18 21:07 Asia/Jerusalem (desktop checker)
Outcome: PASS, run at 0dbaaa2 in postgres:16 (same container as T-0512).
- Step 4: `ok   ledger` (14 migrations), identity "Migrating to version 0002 (2 migrations in total)" with 0002 creating identity.member_preference "-- ok (24.4ms)", then `ok   identity` and org, billing, legal, addons, notify, audit, agent ok.
- Step 5 re-run: "No migration files to execute" x9, all ok.
- Step 6: member_preference_pkey PRIMARY KEY (party_id); check member_preference_receive_currency_check (receive_currency IN 'USD','ILS','as_sent'). As expected.
- Step 7: `INSERT 0 1`. As expected.
- Step 8: `ERROR: new row for relation "member_preference" violates check constraint "member_preference_receive_currency_check"`. As expected.
- Step 9: `club_app=arw/postgres` on identity.member_preference. As expected.
- Step 10: container removed.
