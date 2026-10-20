Task: T-0623 · Branch: claude/practical-babbage-80xevv · Needs: docker
Why: Migration org/0005 adds org.payout_account and org.payout_account_approval: an institution's own bank account, recorded by compliance and taking effect on a second compliance approval. Both are insert-only for club_app, and the IBAN shape is checked. This needs the real Postgres 16 apply; the cloud session only has PGlite. Each statement whose success another depends on is in its own `-c` call. Nothing here is a real institution or bank account (the IBANs are test numbers).
Steps (from repo root, PowerShell on Windows unless stated):
1. docker run --name kesher-pg -e POSTGRES_PASSWORD=postgres -e POSTGRES_DB=club -p 5433:5432 -d postgres:16
2. Start-Sleep -Seconds 8
3. Get-Content -Raw db/roles.sql | docker exec -i kesher-pg psql -U postgres -d club -v ON_ERROR_STOP=1
4. node db/migrate.mjs --docker --url "postgres://postgres:postgres@localhost:5433/club?sslmode=disable"
5. node db/migrate.mjs --docker --url "postgres://postgres:postgres@localhost:5433/club?sslmode=disable"
6. docker exec -i kesher-pg psql -U postgres -d club -c "insert into org.institution (id, name, market) values ('00000000-0000-7000-8000-000000062300', 'T-0623 check', 'IL')"
7. docker exec -i kesher-pg psql -U postgres -d club -c "set role club_app; insert into org.payout_account (id, institution_id, idempotency_key, currency, iban, holder_name, evidence_ref, recorded_by, recorded_at) values ('00000000-0000-7000-8000-000000062301', '00000000-0000-7000-8000-000000062300', 't0623-a', 'ILS', 'IL620108000000099999999', 'T-0623 check', 'letter', '00000000-0000-7000-8000-000000062309', now()) returning seq"
8. docker exec -i kesher-pg psql -U postgres -d club -c "set role club_app; insert into org.payout_account (id, institution_id, idempotency_key, currency, iban, holder_name, evidence_ref, recorded_by, recorded_at) values ('00000000-0000-7000-8000-000000062302', '00000000-0000-7000-8000-000000062300', 't0623-b', 'ILS', 'not an iban', 'T-0623 check', 'letter', '00000000-0000-7000-8000-000000062309', now())"
9. docker exec -i kesher-pg psql -U postgres -d club -c "set role club_app; insert into org.payout_account_approval (account_id, approved_by, approved_at) values ('00000000-0000-7000-8000-000000062301', '00000000-0000-7000-8000-000000062308', now())"
10. docker exec -i kesher-pg psql -U postgres -d club -c "set role club_app; insert into org.payout_account_approval (account_id, approved_by, approved_at) values ('00000000-0000-7000-8000-000000062301', '00000000-0000-7000-8000-000000062307', now())"
11. docker exec -i kesher-pg psql -U postgres -d club -c "set role club_app; update org.payout_account set iban = 'IL070108000000012345678'"
12. docker rm -f kesher-pg
Expected: step 4 prints `ok` for every schema, with org at 5 migrations. Step 5 reports no pending migrations. Step 6 prints `INSERT 0 1`. Step 7 prints one row with a `seq`. Step 8 fails with a check constraint violation (not an IBAN). Step 9 prints `INSERT 0 1`. Step 10 fails with a duplicate key on `payout_account_approval_pkey` (one approval per account). Step 11 fails with `permission denied for table payout_account`.
Report back: the console output of steps 4, 5, 7, 8, 9, 10 and 11.

## Result
PASS, 2026-10-20 23:10 (Asia/Jerusalem). Desktop checker, runner worktree at 3afed51, Docker 29.8.2, postgres:16.

- Step 4: `ok` for ledger, identity, org, billing, legal, addons, notify, audit, agent. Revisions: ledger 21, org 5 (0005 creates org.payout_account).
- Step 5: `No migration files to execute` for every schema, then `ok` for all 9.
- Step 6: `INSERT 0 1`.
- Step 7: `seq` = 1, `INSERT 0 1`.
- Step 8: `ERROR: new row for relation "payout_account" violates check constraint "payout_account_iban_check"`.
- Step 9: `INSERT 0 1`.
- Step 10: `ERROR: duplicate key value violates unique constraint "payout_account_approval_pkey"` — `Key (account_id)=(00000000-0000-7000-8000-000000062301) already exists.`
- Step 11: `ERROR: permission denied for table payout_account`.
- Step 12: container removed. (The tool swallowed the first pass's step 6-11 output, so steps 1-11 were rerun from a fresh container; the results above are from that second pass.)
