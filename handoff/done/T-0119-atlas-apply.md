Task: T-0119 · Branch: claude/practical-babbage-80xevv · Needs: docker
Why: Migration identity/0003 moves members, OTP sessions, passkeys, devices, refresh-token families and recovery restrictions into Postgres (until now they lived in process memory). The cloud session only has PGlite, so the real Postgres 16 apply, the re-run, the grants and the uniqueness checks go on the PC. The values below are dummy bytes, not real phones or tokens. Each statement whose success another depends on is in its own `-c` call.
Steps (from repo root, PowerShell on Windows unless stated):
1. docker run --name kesher-pg -e POSTGRES_PASSWORD=postgres -e POSTGRES_DB=club -p 5433:5432 -d postgres:16
2. Start-Sleep -Seconds 8
3. Get-Content -Raw db/roles.sql | docker exec -i kesher-pg psql -U postgres -d club -v ON_ERROR_STOP=1
4. node db/migrate.mjs --docker --url "postgres://postgres:postgres@localhost:5433/club?sslmode=disable"
5. node db/migrate.mjs --docker --url "postgres://postgres:postgres@localhost:5433/club?sslmode=disable"
6. docker exec -i kesher-pg psql -U postgres -d club -c "\dt identity.*"
7. docker exec -i kesher-pg psql -U postgres -d club -c "set role club_app; insert into identity.user_account (party_id, phone_index, phone_sealed, status, created_at) values ('00000000-0000-7000-8000-000000011901', decode('aa01','hex'), decode('bb01','hex'), 'pending', now())"
8. docker exec -i kesher-pg psql -U postgres -d club -c "set role club_app; insert into identity.user_account (party_id, phone_index, phone_sealed, status, created_at) values ('00000000-0000-7000-8000-000000011902', decode('aa01','hex'), decode('bb02','hex'), 'pending', now())"
9. docker exec -i kesher-pg psql -U postgres -d club -c "set role club_app; update identity.user_account set status = 'active' where party_id = '00000000-0000-7000-8000-000000011901'"
10. docker exec -i kesher-pg psql -U postgres -d club -c "set role club_app; delete from identity.user_account where party_id = '00000000-0000-7000-8000-000000011901'"
11. docker exec -i kesher-pg psql -U postgres -d club -c "set role club_app; insert into identity.session (session_id, party_id, device_id, current_refresh_hash, created_at, refresh_expires_at) values ('00000000-0000-7000-8000-000000011903', '00000000-0000-7000-8000-000000011901', 'd1', 'h1', now(), now() + interval '30 days')"
12. docker exec -i kesher-pg psql -U postgres -d club -c "set role club_app; insert into identity.session_rotated_hash (refresh_hash, session_id) values ('h0', '00000000-0000-7000-8000-000000011903')"
13. docker exec -i kesher-pg psql -U postgres -d club -c "set role club_app; insert into identity.session_rotated_hash (refresh_hash, session_id) values ('h9', '00000000-0000-7000-8000-0000000119ff')"
14. docker rm -f kesher-pg
Expected: step 4 prints `ok` for every schema, with identity at 3 migrations. Step 5 reports no pending migrations. Step 6 lists device, otp_session, otp_start, passkey, restriction, session, session_rotated_hash and user_account. Step 7 prints `INSERT 0 1`. Step 8 fails with a unique violation on the phone_index key (one member per phone). Step 9 prints `UPDATE 1`. Step 10 fails with `permission denied for table user_account`. Step 11 prints `INSERT 0 1`. Step 12 prints `INSERT 0 1`. Step 13 fails with a foreign key violation (no such session).
Report back: the console output of steps 4, 5, 6, 8, 10 and 13.
