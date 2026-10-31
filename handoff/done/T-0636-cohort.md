Task: T-0636 · Branch: claude/practical-babbage-80xevv · Needs: docker
Why: Migration org/0009 adds cohorts and their insert-only placements (REQ-INS-018). This applies it on real Postgres 16 and checks five things. The app role can create a cohort and place a member. A cohort ending before it starts is refused. The same placement key places a member only once. The app role cannot update a placement. Each statement whose success another depends on is in its own `-c` call. Nothing here is real data.
Steps (from repo root, PowerShell on Windows unless stated):
1. $OutputEncoding = New-Object System.Text.UTF8Encoding $false
2. docker run --name kesher-pg -e POSTGRES_PASSWORD=postgres -e POSTGRES_DB=club -p 5433:5432 -d postgres:16
3. Start-Sleep -Seconds 8
4. Get-Content -Raw db/roles.sql | docker exec -i kesher-pg psql -U postgres -d club -v ON_ERROR_STOP=1
5. node db/migrate.mjs --docker --url "postgres://postgres:postgres@localhost:5433/club?sslmode=disable"
6. docker exec -i kesher-pg psql -U postgres -d club -c "insert into org.institution (id, name, market) values ('00000000-0000-7000-8000-000000063601', 'Handoff Yeshiva', 'IL')" -c "insert into org.member (id, institution_id, member_name, status) values ('00000000-0000-7000-8000-000000063602', '00000000-0000-7000-8000-000000063601', 'Handoff Student', 'active')" -c "set role club_app; insert into org.cohort (id, institution_id, idempotency_key, name, starts_on, ends_on, created_by, created_at) values ('00000000-0000-7000-8000-000000063603', '00000000-0000-7000-8000-000000063601', 't0636-cohort', 'Shiur Aleph', '2026-09-01', '2027-06-30', '00000000-0000-7000-8000-0000000636a0', now())" -c "set role club_app; insert into org.cohort_member (id, cohort_id, member_id, idempotency_key, placed_by, placed_at) values ('00000000-0000-7000-8000-000000063604', '00000000-0000-7000-8000-000000063603', '00000000-0000-7000-8000-000000063602', 't0636-place', '00000000-0000-7000-8000-0000000636a0', now())"
7. docker exec -i kesher-pg psql -U postgres -d club -c "set role club_app; insert into org.cohort (id, institution_id, idempotency_key, name, starts_on, ends_on, created_by, created_at) values ('00000000-0000-7000-8000-000000063605', '00000000-0000-7000-8000-000000063601', 't0636-bad', 'Backwards', '2027-06-30', '2026-09-01', '00000000-0000-7000-8000-0000000636a0', now())"
8. docker exec -i kesher-pg psql -U postgres -d club -c "set role club_app; insert into org.cohort_member (id, cohort_id, member_id, idempotency_key, placed_by, placed_at) values ('00000000-0000-7000-8000-000000063606', '00000000-0000-7000-8000-000000063603', '00000000-0000-7000-8000-000000063602', 't0636-place', '00000000-0000-7000-8000-0000000636a0', now()) on conflict (idempotency_key, member_id) do nothing"
9. docker exec -i kesher-pg psql -U postgres -d club -c "set role club_app; update org.cohort_member set cohort_id = cohort_id"
10. docker exec -i kesher-pg psql -U postgres -d club -c "select c.name, count(cm.id) from org.cohort c left join org.cohort_member cm on cm.cohort_id = c.id group by c.name"
11. docker rm -f kesher-pg
Expected: step 5 prints `ok` for every schema, with org at 9 migrations. Step 6 prints `INSERT 0 1` twice, then `SET` and `INSERT 0 1` twice. Step 7 prints `SET` and an error: new row violates check constraint `cohort_check`. Step 8 prints `SET` and `INSERT 0 0`. Step 9 prints `SET` and `ERROR: permission denied for table cohort_member`. Step 10 prints one row: `Shiur Aleph | 1`.
Report back: the console output of steps 5 to 10.

## Result
PASS · 2026-11-01 00:07 Asia/Jerusalem · runner worktree at 214a070 (branch head), Docker 29.8.2, postgres:16, fresh container, removed after.
- Step 4 (roles.sql): DO, DO, REVOKE, ALTER ROLE, ALTER DEFAULT PRIVILEGES, ALTER ROLE x6.
- Step 5: `ok` for ledger, identity, org, billing, legal, addons, notify, audit, agent. org applied 10 migrations, not 9: the branch head also carries org/0010 (T-0643).
- Step 6: INSERT 0 1, INSERT 0 1, SET, INSERT 0 1, SET, INSERT 0 1.
- Step 7: SET; ERROR: new row for relation "cohort" violates check constraint "cohort_check" (exit 1).
- Step 8: SET; INSERT 0 0.
- Step 9: SET; ERROR: permission denied for table cohort_member (exit 1).
- Step 10: `Shiur Aleph | 1` (1 row).
- Step 11: container removed.
Note: a first pass lost psql stderr in the PowerShell bridge; it was discarded and rerun in a fresh container with stderr captured. Both passes agreed on stdout.
