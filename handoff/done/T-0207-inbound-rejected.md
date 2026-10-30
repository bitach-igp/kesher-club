Task: T-0207 · Branch: claude/practical-babbage-80xevv · Needs: docker
Why: Migration ledger/0023 adds ops.inbound_rejected, where a webhook delivery that fails its signature is now kept for forensics, so it no longer holds the provider's event id in ops.inbound_event (REQ-LED-005). It also moves any refused rows already in ops.inbound_event across. This applies it on real Postgres 16 and checks the app role can add to the new table but not change or remove its rows. Each statement whose success another depends on is in its own `-c` call. Nothing here is real data.
Steps (from repo root, PowerShell on Windows unless stated):
1. docker run --name kesher-pg -e POSTGRES_PASSWORD=postgres -e POSTGRES_DB=club -p 5433:5432 -d postgres:16
2. Start-Sleep -Seconds 8
3. Get-Content -Raw db/roles.sql | docker exec -i kesher-pg psql -U postgres -d club -v ON_ERROR_STOP=1
4. node db/migrate.mjs --docker --url "postgres://postgres:postgres@localhost:5433/club?sslmode=disable"
5. docker exec -i kesher-pg psql -U postgres -d club -c "set role club_app; insert into ops.inbound_rejected (id, provider, event_id, received_at, payload, market) values ('00000000-0000-7000-8000-000000020701', 'simulator', 'evt-forged', now(), '{}', 'IL')"
6. docker exec -i kesher-pg psql -U postgres -d club -c "set role club_app; insert into ops.inbound_event (provider, event_id, signature_ok, payload, market) values ('simulator', 'evt-forged', true, '{}', 'IL')"
7. docker exec -i kesher-pg psql -U postgres -d club -c "set role club_app; update ops.inbound_rejected set payload = '{}'"
8. docker exec -i kesher-pg psql -U postgres -d club -c "set role club_app; delete from ops.inbound_rejected"
9. docker rm -f kesher-pg
Expected: step 4 prints `ok` for every schema, with ledger at 23 migrations. Step 5 prints `SET` then `INSERT 0 1`. Step 6 prints `SET` then `INSERT 0 1`: the forged row holds no claim on the event id. Steps 7 and 8 each fail with `permission denied for table inbound_rejected`.
Report back: the console output of steps 4 to 8.

## Result
PASS, 2026-10-30 16:10 Asia/Jerusalem, on runner worktree at 717a4f1 (branch head, which also carries ledger/0024), Docker 29.8.2, postgres:16.
- Step 3: `DO`, `DO`, `REVOKE`, `ALTER ROLE` (PowerShell 5.1 needs `$OutputEncoding = New-Object System.Text.UTF8Encoding $false` first, or the pipe prepends a BOM and psql fails on line 1).
- Step 4: `Migrating to version 0024 (24 migrations in total)` for ledger; `ok` for ledger, identity, org, billing, legal, addons, notify, audit, agent.
- Step 5: `SET` / `INSERT 0 1`
- Step 6: `SET` / `INSERT 0 1` (the forged row holds no claim on the event id)
- Step 7: `ERROR:  permission denied for table inbound_rejected`
- Step 8: `ERROR:  permission denied for table inbound_rejected`
- Step 9: container removed.
