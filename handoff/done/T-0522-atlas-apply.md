Task: T-0522 · Branch: claude/practical-babbage-80xevv · Needs: docker
Why: Migration ledger/0017 adds ops.fx_quote, so a quote one API instance issued can be converted by another. Its checks, the unique (party_id, idempotency_key) and the foreign key to ops.fx_rate need the real Postgres 16 apply and the club_app grants checked. The cloud session only has PGlite. Each statement whose success another depends on is in its own `-c` call. Nothing here is a real member.
Steps (from repo root, PowerShell on Windows unless stated):
1. docker run --name kesher-pg -e POSTGRES_PASSWORD=postgres -e POSTGRES_DB=club -p 5433:5432 -d postgres:16
2. Start-Sleep -Seconds 8
3. Get-Content -Raw db/roles.sql | docker exec -i kesher-pg psql -U postgres -d club -v ON_ERROR_STOP=1
4. node db/migrate.mjs --docker --url "postgres://postgres:postgres@localhost:5433/club?sslmode=disable"
5. node db/migrate.mjs --docker --url "postgres://postgres:postgres@localhost:5433/club?sslmode=disable"
6. docker exec -i kesher-pg psql -U postgres -d club -c "insert into ops.fx_rate (id, pair, version, mid_scaled, source, status, proposed_by) values ('00000000-0000-7000-8000-000000052201', 'USD/ILS', 1, 3700000, 'manual', 'active', 'handoff')"
7. docker exec -i kesher-pg psql -U postgres -d club -c "set role club_app; insert into ops.fx_quote (id, party_id, idempotency_key, from_minor, from_currency, to_currency, rate_scaled, markup_bps, total_minor, markup_minor, rate_id, rate_version, market, expires_at) values ('cq_t0522_a', '00000000-0000-7000-8000-000000052202', 't0522-key-a', 1000, 'USD', 'ILS', 3700000, 75, 3672, 28, '00000000-0000-7000-8000-000000052201', 1, 'IL', now() + interval '30 seconds')"
8. docker exec -i kesher-pg psql -U postgres -d club -c "set role club_app; update ops.fx_quote set spent_key = 't0522-convert', spent_at = now() where id = 'cq_t0522_a' and (spent_key is null or spent_key = 't0522-convert')"
9. docker exec -i kesher-pg psql -U postgres -d club -c "set role club_app; update ops.fx_quote set spent_key = 't0522-other', spent_at = now() where id = 'cq_t0522_a' and (spent_key is null or spent_key = 't0522-other')"
10. docker exec -i kesher-pg psql -U postgres -d club -c "set role club_app; insert into ops.fx_quote (id, party_id, idempotency_key, from_minor, from_currency, to_currency, rate_scaled, markup_bps, total_minor, markup_minor, rate_id, rate_version, market, expires_at) values ('cq_t0522_b', '00000000-0000-7000-8000-000000052202', 't0522-key-a', 1000, 'USD', 'ILS', 3700000, 75, 3672, 28, '00000000-0000-7000-8000-000000052201', 1, 'IL', now())"
11. docker exec -i kesher-pg psql -U postgres -d club -c "set role club_app; insert into ops.fx_quote (id, party_id, idempotency_key, from_minor, from_currency, to_currency, rate_scaled, markup_bps, total_minor, markup_minor, rate_id, rate_version, market, expires_at) values ('cq_t0522_c', '00000000-0000-7000-8000-000000052202', 't0522-key-c', 1000, 'USD', 'USD', 3700000, 75, 3672, 28, '00000000-0000-7000-8000-000000052201', 1, 'IL', now())"
12. docker rm -f kesher-pg
Expected: step 4 prints `ok` for every schema, with ledger at 17 migrations. Step 5 reports no pending migrations. Step 6 prints `INSERT 0 1`. Step 7 prints `INSERT 0 1`. Step 8 prints `UPDATE 1` (the conversion's key spends the quote). Step 9 prints `UPDATE 0` (another key cannot spend it again). Step 10 fails with a unique violation on (party_id, idempotency_key). Step 11 fails with a check constraint violation (from and to are the same currency).
Report back: the console output of steps 4, 5, 8, 9, 10 and 11.

## Result
Outcome: PASS. Run 2026-10-19 18:05 (Asia/Jerusalem) by the desktop checker on Zvi's PC, runner worktree at 2238672, Docker 29.8.2, postgres:16.
- Step 4: applied (the first call's console output was lost to a tool timeout; the database shows it). `atlas_ledger.atlas_schema_revisions`: 17 rows, latest `0017 fx_quote` (0016 row_market, 0015 job_run); `ops.fx_quote` exists.
- Step 5: `No migration files to execute` for every schema, then `ok` for ledger, identity, org, billing, legal, addons, notify, audit, agent; exit 0.
- Step 6: `INSERT 0 1`. Step 7: `SET` / `INSERT 0 1`.
- Step 8: `UPDATE 1` (the conversion key spends the quote).
- Step 9: `UPDATE 0` (another key cannot spend it).
- Step 10: `ERROR: duplicate key value violates unique constraint "fx_quote_party_id_idempotency_key_key"` / `Key (party_id, idempotency_key)=(00000000-0000-7000-8000-000000052202, t0522-key-a) already exists.`
- Step 11: `ERROR: new row for relation "fx_quote" violates check constraint "fx_quote_check"` (from = to = USD).
- Step 12: container removed.
