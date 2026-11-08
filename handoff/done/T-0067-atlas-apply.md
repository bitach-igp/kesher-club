Task: T-0067 · Branch: card/T-0067 · Needs: docker
Why: legal/0002 drops NOT NULL on legal.consent.ip; PGlite proves the service code, but only a real Postgres 16 shows the migration applies on top of 0001 and that a row with no address inserts as the service role.
Steps (from repo root, PowerShell on Windows unless stated; the password below is a throwaway for this local container):
1. docker run --name kesher-pg -e POSTGRES_PASSWORD=postgres -e POSTGRES_DB=club -p 5433:5432 -d postgres:16
2. Start-Sleep -Seconds 8
3. Get-Content -Raw db/roles.sql | docker exec -i kesher-pg psql -U postgres -d club -v ON_ERROR_STOP=1
4. node db/migrate.mjs --docker --url "postgres://postgres:postgres@localhost:5433/club?sslmode=disable"
5. docker exec kesher-pg psql -U postgres -d club -c "select column_name, is_nullable from information_schema.columns where table_schema = 'legal' and table_name = 'consent' and column_name = 'ip'"
6. docker exec kesher-pg psql -U postgres -d club -c "insert into legal.document_version (doc_key, version, title_en, title_he, body_en, body_he, hash, material, published_by, effective_at, published_at) values ('terms', 1, 't', 't', 'b', 'b', 'h', true, gen_random_uuid(), now(), now())"
7. docker exec kesher-pg psql -U postgres -d club -c "set role club_app; insert into legal.consent (id, party_id, doc_key, version, hash, device_id, ip, locale, accepted_at) values (gen_random_uuid(), gen_random_uuid(), 'terms', 1, 'h', 'd', null, 'en', now()); select count(*) from legal.consent where ip is null"
8. docker rm -f kesher-pg
Expected: step 4 prints `ok` for every schema including legal (0002 applied). Step 5 shows `ip | YES`. Step 7 prints `SET` and `INSERT 0 1` and then count 1: one row with a null ip, inserted as club_app.
Report back: the console output of steps 4, 5 and 7, and `docker --version`.

## Result
PASS, 2026-11-08 19:10 (Asia/Jerusalem), desktop runner at 0343fd3 (Docker 29.9.2, build a82e528).
- Step 4: all nine schemas `ok` (ledger, identity, org, billing, legal, addons, notify, audit, agent); legal "Migrating to version 0002 (2 migrations in total)", `alter table legal.consent alter column ip drop not null;` -> ok (14.8ms).
- Step 5: `ip | YES` (1 row).
- Step 6: `INSERT 0 1`.
- Step 7: `SET`, `INSERT 0 1`, count `1` (null-ip row inserted as club_app).
- Step 8: container removed.
