Task: T-0738 · Branch: cards/T-0738-subaccount-owner-details · Needs: docker
Why: Migration identity/0007 adds identity.member_funding_details, the member's sub-account owner contact as PII-sealed bytea (or an invitation email only). club_app may select, insert and update a row, but not delete it, and the row has two shapes (whole owner, or email only). The cloud session only has PGlite. Each statement whose success another depends on is in its own `-c` call. The bytes below are placeholders, not sealed values.
Steps (from repo root, PowerShell on Windows unless stated):
1. docker run --name kesher-pg -e POSTGRES_PASSWORD=postgres -e POSTGRES_DB=club -p 5433:5432 -d postgres:16
2. Start-Sleep -Seconds 8
3. Get-Content -Raw db/roles.sql | docker exec -i kesher-pg psql -U postgres -d club -v ON_ERROR_STOP=1
4. node db/migrate.mjs --docker --url "postgres://postgres:postgres@localhost:5433/club?sslmode=disable"
5. node db/migrate.mjs --docker --url "postgres://postgres:postgres@localhost:5433/club?sslmode=disable"
6. docker exec -i kesher-pg psql -U postgres -d club -c "set role club_app; insert into identity.member_funding_details (party_id, first_name, last_name, email, date_of_birth, updated_at) values ('00000000-0000-7000-8000-000000073800', '\x01aa', '\x01bb', '\x01cc', '\x01dd', now())"
7. docker exec -i kesher-pg psql -U postgres -d club -c "set role club_app; update identity.member_funding_details set first_name = null, last_name = null, date_of_birth = null, updated_at = now() where party_id = '00000000-0000-7000-8000-000000073800'"
8. docker exec -i kesher-pg psql -U postgres -d club -c "set role club_app; update identity.member_funding_details set first_name = '\x01aa', updated_at = now() where party_id = '00000000-0000-7000-8000-000000073800'"
9. docker exec -i kesher-pg psql -U postgres -d club -c "set role club_app; delete from identity.member_funding_details"
10. docker rm -f kesher-pg
Expected: step 4 prints `ok` for every schema, with identity at 7 migrations. Step 5 reports no pending migrations. Step 6 prints `INSERT 0 1`. Step 7 prints `UPDATE 1` (the email-only shape). Step 8 fails with a check violation on `member_funding_details_shape` (a first name without a last name). Step 9 fails with `permission denied for table member_funding_details`.
Report back: the console output of steps 4 to 9.

## Result
PASS, 2026-11-18 19:07 (Asia/Jerusalem), desktop checker on runner worktree at 5e4010f, Docker 29.9.2 (Docker Desktop was not running; started it, no settings changed), postgres:16.
- Step 3: roles.sql applied (ALTER ROLE ...).
- Step 4: `ok` for ledger, identity, org, billing, legal, addons, notify, audit, agent; atlas_identity.atlas_schema_revisions holds 0001..0007 (identity at 7).
- Step 5: `No migration files to execute`, all 9 schemas `ok`.
- Step 6: `INSERT 0 1`.
- Step 7: `UPDATE 1` (email-only shape).
- Step 8: `ERROR: new row for relation "member_funding_details" violates check constraint "member_funding_details_shape"` (first name without last name), exit 1.
- Step 9: `ERROR: permission denied for table member_funding_details`, exit 1; the row is still there (1 row, first_name null).
- Step 10: container removed.
