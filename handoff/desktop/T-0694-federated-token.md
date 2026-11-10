Task: T-0694 · Branch: card/T-0694 · Needs: docker
Why: Migration identity/0006 adds identity.federated_token (the sealed Apple refresh token). The cloud session only has PGlite, so the real Postgres 16 apply, the table shape, the club_app grants (select, insert, delete only) and the primary-key violation go on the PC. Values are dummy. Each statement whose success another depends on is in its own `-c` call.
Steps (from repo root, PowerShell on Windows unless stated):
1. docker run --name kesher-pg -e POSTGRES_PASSWORD=postgres -e POSTGRES_DB=club -p 5433:5432 -d postgres:16
2. Start-Sleep -Seconds 8
3. Get-Content -Raw db/roles.sql | docker exec -i kesher-pg psql -U postgres -d club -v ON_ERROR_STOP=1
4. node db/migrate.mjs --docker --url "postgres://postgres:postgres@localhost:5433/club?sslmode=disable"
5. node db/migrate.mjs --docker --url "postgres://postgres:postgres@localhost:5433/club?sslmode=disable"
6. docker exec -i kesher-pg psql -U postgres -d club -c "\d identity.federated_token"
7. docker exec -i kesher-pg psql -U postgres -d club -c "select grantee, privilege_type from information_schema.role_table_grants where table_schema = 'identity' and table_name = 'federated_token' and grantee = 'club_app' order by privilege_type"
8. docker exec -i kesher-pg psql -U postgres -d club -c "set role club_app; insert into identity.federated_token (party_id, provider, refresh_token_sealed, created_at) values ('00000000-0000-7000-8000-000000069401', 'apple', decode('0102030405', 'hex'), now())"
9. docker exec -i kesher-pg psql -U postgres -d club -c "set role club_app; insert into identity.federated_token (party_id, provider, refresh_token_sealed, created_at) values ('00000000-0000-7000-8000-000000069401', 'apple', decode('0a0b0c', 'hex'), now())"
10. docker exec -i kesher-pg psql -U postgres -d club -c "set role club_app; insert into identity.federated_token (party_id, provider, refresh_token_sealed, created_at) values ('00000000-0000-7000-8000-000000069402', 'facebook', decode('01', 'hex'), now())"
11. docker exec -i kesher-pg psql -U postgres -d club -c "set role club_app; insert into identity.federated_token (party_id, provider, refresh_token_sealed, created_at) values ('00000000-0000-7000-8000-000000069403', 'apple', null, now())"
12. docker exec -i kesher-pg psql -U postgres -d club -c "set role club_app; select party_id, provider from identity.federated_token"
13. docker exec -i kesher-pg psql -U postgres -d club -c "set role club_app; update identity.federated_token set provider = 'google' where party_id = '00000000-0000-7000-8000-000000069401'"
14. docker exec -i kesher-pg psql -U postgres -d club -c "set role club_app; delete from identity.federated_token where party_id = '00000000-0000-7000-8000-000000069401' and provider = 'apple' returning party_id"
15. docker exec -i kesher-pg psql -U postgres -d club -c "set role club_app; insert into ops.external_ref (entity_type, entity_id, provider, external_id) values ('member', '00000000-0000-7000-8000-000000069401', 'apple', 'sub-69401')"
16. docker exec -i kesher-pg psql -U postgres -d club -c "set role club_app; delete from ops.external_ref where provider = 'apple' and external_id = 'sub-69401'"
17. docker rm -f kesher-pg
Expected: step 4 prints `ok` for every schema, with identity at 6 migrations. Step 5 reports no pending migrations. Step 6 shows columns party_id uuid, provider text, refresh_token_sealed bytea, created_at timestamptz (all not null) and the primary key (party_id, provider) plus the provider check. Step 7 lists exactly DELETE, INSERT, SELECT. Step 8 prints `INSERT 0 1`. Step 9 fails with a unique violation on `federated_token_pkey` (one token per member and provider). Step 10 fails with a check violation on provider. Step 11 fails with a not-null violation on refresh_token_sealed. Step 12 prints the one row from step 8. Step 13 fails with `permission denied for table federated_token` (no UPDATE grant). Step 14 prints one row and `DELETE 1`. Step 15 prints `INSERT 0 1` (club_app may insert the link row that `link` writes). Step 16 fails with `permission denied for table external_ref` (club_app has no DELETE on ops; this is why unlink is not in this card).
Report back: the console output of steps 4, 5, 6, 7, 8, 9, 10, 11, 13, 14, 15 and 16.
