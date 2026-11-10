Task: T-0682 · Branch: card/T-0682 · Needs: docker
Why: Migration identity/0005 adds identity.passkey_ceremony and identity.step_up_token (passkey ceremonies and step-up tokens, until now process memory). The cloud session only has PGlite, so the real Postgres 16 apply, the re-run, the club_app grants, the single-use take and the one-live-ceremony rule go on the PC. Values are dummy. Each statement whose success another depends on is in its own `-c` call.
Steps (from repo root, PowerShell on Windows unless stated):
1. docker run --name kesher-pg -e POSTGRES_PASSWORD=postgres -e POSTGRES_DB=club -p 5433:5432 -d postgres:16
2. Start-Sleep -Seconds 8
3. Get-Content -Raw db/roles.sql | docker exec -i kesher-pg psql -U postgres -d club -v ON_ERROR_STOP=1
4. node db/migrate.mjs --docker --url "postgres://postgres:postgres@localhost:5433/club?sslmode=disable"
5. node db/migrate.mjs --docker --url "postgres://postgres:postgres@localhost:5433/club?sslmode=disable"
6. docker exec -i kesher-pg psql -U postgres -d club -c "\dt identity.*"
7. docker exec -i kesher-pg psql -U postgres -d club -c "set role club_app; insert into identity.passkey_ceremony (ceremony_id, kind, session_id, party_id, options, issued_at) values ('00000000-0000-7000-8000-000000068201', 'step_up', 'sess-682', 'p-682', '{\"challenge\":\"c1\"}'::jsonb, now())"
8. docker exec -i kesher-pg psql -U postgres -d club -c "set role club_app; insert into identity.passkey_ceremony (ceremony_id, kind, session_id, party_id, options, issued_at) values ('00000000-0000-7000-8000-000000068202', 'step_up', 'sess-682', 'p-682', '{\"challenge\":\"c2\"}'::jsonb, now())"
9. docker exec -i kesher-pg psql -U postgres -d club -c "set role club_app; insert into identity.passkey_ceremony (ceremony_id, kind, session_id, party_id, options, issued_at) values ('00000000-0000-7000-8000-000000068203', 'bogus', 'sess-682', 'p-682', '{}'::jsonb, now())"
10. docker exec -i kesher-pg psql -U postgres -d club -c "set role club_app; insert into identity.passkey_ceremony (ceremony_id, kind, session_id, party_id, options, issued_at) values ('00000000-0000-7000-8000-000000068201', 'step_up', 'sess-682', 'p-682', '{\"challenge\":\"c1\"}'::jsonb, now()) on conflict (kind, session_id) do update set ceremony_id = excluded.ceremony_id, options = excluded.options, issued_at = excluded.issued_at, consumed_at = null"
11. docker exec -i kesher-pg psql -U postgres -d club -c "set role club_app; update identity.passkey_ceremony set consumed_at = now() where kind = 'step_up' and session_id = 'sess-682' and consumed_at is null returning ceremony_id"
12. docker exec -i kesher-pg psql -U postgres -d club -c "set role club_app; update identity.passkey_ceremony set consumed_at = now() where kind = 'step_up' and session_id = 'sess-682' and consumed_at is null returning ceremony_id"
13. docker exec -i kesher-pg psql -U postgres -d club -c "set role club_app; insert into identity.step_up_token (session_id, token_hash, expires_at) values ('sess-682', 'hash-682', now() + interval '5 minutes')"
14. docker exec -i kesher-pg psql -U postgres -d club -c "set role club_app; insert into identity.step_up_token (session_id, token_hash, expires_at) values ('sess-682', 'hash-682b', now() + interval '5 minutes')"
15. docker exec -i kesher-pg psql -U postgres -d club -c "set role club_app; delete from identity.step_up_token where expires_at < now() + interval '1 hour' returning session_id"
16. docker exec -i kesher-pg psql -U postgres -d club -c "set role club_app; delete from identity.passkey_ceremony where issued_at < now() + interval '1 hour' returning ceremony_id"
17. docker rm -f kesher-pg
Expected: step 4 prints `ok` for every schema, with identity at 5 migrations. Step 5 reports no pending migrations. Step 6 lists passkey_ceremony and step_up_token among the identity tables. Step 7 prints `INSERT 0 1`. Step 8 fails with a unique violation on (kind, session_id): one live ceremony per kind and key. Step 9 fails with a check violation on kind. Step 10 prints `INSERT 0 1` (the upsert replaces the ceremony and clears consumed_at). Step 11 prints one row and `UPDATE 1`. Step 12 prints no rows and `UPDATE 0` (single-use). Step 13 prints `INSERT 0 1`. Step 14 fails with a unique violation on the primary key (one token per session; the app upserts). Steps 15 and 16 each print one row and a `DELETE 1` (club_app may delete expired rows).
Report back: the console output of steps 4, 5, 6, 8, 9, 12 and 14.

## Result
PASS, 2026-11-10 03:11 Asia/Jerusalem, runner worktree at d17d04e, Docker 29.9.2, postgres:16. Step 3 piped with a BOM-less `$OutputEncoding` (PowerShell 5.1 otherwise prepends a BOM); steps 7 to 16 run through `cmd /c` so the `\"` quoting reaches psql unchanged. Every step matched the expected outcome.
- Step 4: `Migrating to version 0005 (5 migrations in total)` for identity; `ok` for all nine schemas.
- Step 5: `No migration files to execute` for every schema, `ok` for all nine.
- Step 6: 13 identity tables, including `passkey_ceremony` and `step_up_token`.
- Step 7: `INSERT 0 1`.
- Step 8: `ERROR:  duplicate key value violates unique constraint "passkey_ceremony_kind_session_id_key"` / `DETAIL:  Key (kind, session_id)=(step_up, sess-682) already exists.`
- Step 9: `ERROR:  new row for relation "passkey_ceremony" violates check constraint "passkey_ceremony_kind_check"`.
- Step 10: `INSERT 0 1` (upsert).
- Step 11: one row `00000000-0000-7000-8000-000000068201`, `UPDATE 1`.
- Step 12: `(0 rows)`, `UPDATE 0` (single-use).
- Step 13: `INSERT 0 1`.
- Step 14: `ERROR:  duplicate key value violates unique constraint "step_up_token_pkey"` / `DETAIL:  Key (session_id)=(sess-682) already exists.`
- Step 15: one row `sess-682`, `DELETE 1`. Step 16: one row `00000000-0000-7000-8000-000000068201`, `DELETE 1`.
- Step 17: container removed.
