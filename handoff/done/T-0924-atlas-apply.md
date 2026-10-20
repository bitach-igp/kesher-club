Task: T-0924 · Branch: claude/practical-babbage-80xevv · Needs: docker
Why: Migration ledger/0018 widens the ops.approval_request kind check to add `staff_grant` (dropped and re-added NOT VALID in one migration), and org/0003 adds org.institution_onboarding with its club_app grant. Both need the real Postgres 16 apply; the cloud session only has PGlite. Each statement whose success another depends on is in its own `-c` call. Nothing here is a real member.
Steps (from repo root, PowerShell on Windows unless stated):
1. docker run --name kesher-pg -e POSTGRES_PASSWORD=postgres -e POSTGRES_DB=club -p 5433:5432 -d postgres:16
2. Start-Sleep -Seconds 8
3. Get-Content -Raw db/roles.sql | docker exec -i kesher-pg psql -U postgres -d club -v ON_ERROR_STOP=1
4. node db/migrate.mjs --docker --url "postgres://postgres:postgres@localhost:5433/club?sslmode=disable"
5. node db/migrate.mjs --docker --url "postgres://postgres:postgres@localhost:5433/club?sslmode=disable"
6. docker exec -i kesher-pg psql -U postgres -d club -c "set role club_app; insert into ops.approval_request (id, kind, subject, payload, required, scope, requested_by, status, expires_at, created_at) values ('00000000-0000-7000-8000-000000092401', 'staff_grant', 'staff:t0924', '{}', 2, 'platform', '00000000-0000-7000-8000-000000092402', 'awaiting_second_approval', now() + interval '7 days', now())"
7. docker exec -i kesher-pg psql -U postgres -d club -c "set role club_app; insert into ops.approval_request (id, kind, subject, payload, required, scope, requested_by, status, expires_at, created_at) values ('00000000-0000-7000-8000-000000092403', 'staff_bogus', 'staff:t0924b', '{}', 2, 'platform', '00000000-0000-7000-8000-000000092402', 'awaiting_second_approval', now() + interval '7 days', now())"
8. docker exec -i kesher-pg psql -U postgres -d club -c "set role club_app; insert into org.institution (id, name, market) values ('00000000-0000-7000-8000-000000092404', 'Handoff Yeshiva', 'IL')"
9. docker exec -i kesher-pg psql -U postgres -d club -c "set role club_app; insert into org.institution_onboarding (idempotency_key, institution_id, created_by, created_at) values ('t0924-key-a', '00000000-0000-7000-8000-000000092404', '00000000-0000-7000-8000-000000092402', now())"
10. docker exec -i kesher-pg psql -U postgres -d club -c "set role club_app; insert into org.institution_onboarding (idempotency_key, institution_id, created_by, created_at) values ('t0924-key-a', '00000000-0000-7000-8000-000000092404', '00000000-0000-7000-8000-000000092402', now())"
11. docker exec -i kesher-pg psql -U postgres -d club -c "set role club_app; delete from org.institution_onboarding"
12. docker rm -f kesher-pg
Expected: step 4 prints `ok` for every schema, with ledger at 18 migrations and org at 3. Step 5 reports no pending migrations. Step 6 prints `INSERT 0 1` (the new kind is allowed). Step 7 fails with a check constraint violation on `approval_request_kind_check`. Step 8 prints `INSERT 0 1`. Step 9 prints `INSERT 0 1`. Step 10 fails with a unique violation on the idempotency key. Step 11 fails with `permission denied for table institution_onboarding` (insert-only for club_app).
Report back: the console output of steps 4, 5, 6, 7, 9, 10 and 11.

## Result
Outcome: PASS. Run 2026-10-20 10:07 (Asia/Jerusalem) by the desktop checker on Zvi's PC, runner worktree at
b9cfb2e, Docker 29.8.2, postgres:16. Every step matched Expected. (Steps 1-12 were run once; the
failing steps' stderr was not captured by PowerShell, so 1-12 were run a second time on a fresh
container to capture it. Both runs agreed.)

- Step 4: ledger "Migrating to version 0018 (18 migrations in total)", 0018 applied the drop + re-add
  `approval_request_kind_check ... 'staff_grant') not valid` in 12 ms; org "Migrating to version 0003
  (3 migrations in total)"; then `ok` for ledger, identity, org, billing, legal, addons, notify, audit,
  agent; exit 0.
- Step 5: "No migration files to execute" for every schema, `ok` for all 9; exit 0.
- Step 6: `INSERT 0 1`.
- Step 7: `ERROR:  new row for relation "approval_request" violates check constraint "approval_request_kind_check"`; exit 1.
- Step 8: `INSERT 0 1`.
- Step 9: `INSERT 0 1`.
- Step 10: `ERROR:  duplicate key value violates unique constraint "institution_onboarding_pkey"`
  / `Key (idempotency_key)=(t0924-key-a) already exists.`; exit 1.
- Step 11: `ERROR:  permission denied for table institution_onboarding`; exit 1.
- Step 12: container removed.
