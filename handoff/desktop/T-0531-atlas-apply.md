Task: T-0531 · Branch: claude/practical-babbage-80xevv · Needs: docker
Why: Migration identity/0004 adds identity.member_display_name, the name others see when they pay a member. It holds the first name and the last initial as PII-sealed bytea. club_app may insert and update a member's row, but not delete it. This needs the real Postgres 16 apply; the cloud session only has PGlite. Each statement whose success another depends on is in its own `-c` call. The bytes below are placeholders, not a sealed name.
Steps (from repo root, PowerShell on Windows unless stated):
1. docker run --name kesher-pg -e POSTGRES_PASSWORD=postgres -e POSTGRES_DB=club -p 5433:5432 -d postgres:16
2. Start-Sleep -Seconds 8
3. Get-Content -Raw db/roles.sql | docker exec -i kesher-pg psql -U postgres -d club -v ON_ERROR_STOP=1
4. node db/migrate.mjs --docker --url "postgres://postgres:postgres@localhost:5433/club?sslmode=disable"
5. node db/migrate.mjs --docker --url "postgres://postgres:postgres@localhost:5433/club?sslmode=disable"
6. docker exec -i kesher-pg psql -U postgres -d club -c "set role club_app; insert into identity.member_display_name (party_id, first_name, last_initial, updated_at) values ('00000000-0000-7000-8000-000000053100', '\x01aabb', '\x01cc', now())"
7. docker exec -i kesher-pg psql -U postgres -d club -c "set role club_app; update identity.member_display_name set last_initial = null, updated_at = now() where party_id = '00000000-0000-7000-8000-000000053100'"
8. docker exec -i kesher-pg psql -U postgres -d club -c "set role club_app; insert into identity.member_display_name (party_id, first_name, updated_at) values ('00000000-0000-7000-8000-000000053100', '\x01dd', now())"
9. docker exec -i kesher-pg psql -U postgres -d club -c "set role club_app; delete from identity.member_display_name"
10. docker rm -f kesher-pg
Expected: step 4 prints `ok` for every schema, with identity at 4 migrations. Step 5 reports no pending migrations. Step 6 prints `INSERT 0 1`. Step 7 prints `UPDATE 1`. Step 8 fails with a duplicate key on `member_display_name_pkey` (one row per member). Step 9 fails with `permission denied for table member_display_name`.
Report back: the console output of steps 4 to 9.
