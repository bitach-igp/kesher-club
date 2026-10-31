Task: T-0632 · Branch: claude/practical-babbage-80xevv · Needs: docker
Why: Migration org/0008 adds self-serve institution applications (REQ-INS-016): `org.institution_application` and its insert-only event log. This applies it on real Postgres 16 and checks three things. The app role can insert an application and an event. A second application by the same person is refused. The app role cannot update an application, which is insert-only. Each statement whose success another depends on is in its own `-c` call. Nothing here is real data.
Steps (from repo root, PowerShell on Windows unless stated):
1. $OutputEncoding = New-Object System.Text.UTF8Encoding $false
2. docker run --name kesher-pg -e POSTGRES_PASSWORD=postgres -e POSTGRES_DB=club -p 5433:5432 -d postgres:16
3. Start-Sleep -Seconds 8
4. Get-Content -Raw db/roles.sql | docker exec -i kesher-pg psql -U postgres -d club -v ON_ERROR_STOP=1
5. node db/migrate.mjs --docker --url "postgres://postgres:postgres@localhost:5433/club?sslmode=disable"
6. docker exec -i kesher-pg psql -U postgres -d club -c "insert into org.institution (id, name, market) values ('00000000-0000-7000-8000-000000063201', 'Handoff Yeshiva', 'IL')" -c "set role club_app; insert into org.institution_application (id, institution_id, applicant_party_id, idempotency_key, legal_name, registration_number, address, created_at) values ('00000000-0000-7000-8000-000000063202', '00000000-0000-7000-8000-000000063201', '00000000-0000-7000-8000-0000000632a0', 't0632-check', 'Handoff Yeshiva', '580000000', '{}', now())" -c "set role club_app; insert into org.institution_application_event (id, application_id, kind, by_party, at) values ('00000000-0000-7000-8000-000000063203', '00000000-0000-7000-8000-000000063202', 'submitted', '00000000-0000-7000-8000-0000000632a0', now())"
7. docker exec -i kesher-pg psql -U postgres -d club -c "insert into org.institution (id, name, market) values ('00000000-0000-7000-8000-000000063204', 'Second Yeshiva', 'IL')" -c "set role club_app; insert into org.institution_application (id, institution_id, applicant_party_id, idempotency_key, legal_name, registration_number, address, created_at) values ('00000000-0000-7000-8000-000000063205', '00000000-0000-7000-8000-000000063204', '00000000-0000-7000-8000-0000000632a0', 't0632-check-2', 'Second Yeshiva', '580000001', '{}', now())"
8. docker exec -i kesher-pg psql -U postgres -d club -c "set role club_app; update org.institution_application set legal_name = 'Changed' where id = '00000000-0000-7000-8000-000000063202'"
9. docker exec -i kesher-pg psql -U postgres -d club -c "select a.legal_name, e.kind from org.institution_application a join org.institution_application_event e on e.application_id = a.id"
10. docker rm -f kesher-pg
Expected: step 5 prints `ok` for every schema, with org at 8 migrations. Step 6 prints `INSERT 0 1`, then `SET` and `INSERT 0 1` twice. Step 7 prints `INSERT 0 1`, then `SET` and an error: duplicate key value violates unique constraint on `applicant_party_id`. Step 8 prints `SET` and `ERROR: permission denied for table institution_application`. Step 9 prints one row: `Handoff Yeshiva | submitted`.
Report back: the console output of steps 5 to 9.

## Result
PASS, 2026-10-31 22:15 (Asia/Jerusalem), Kesher desktop checker on runner worktree at 7377036, Docker 29.8.2, postgres:16 (fresh container, removed after).
- Step 4 (roles.sql): DO, DO, REVOKE, ALTER ROLE, ALTER DEFAULT PRIVILEGES, ALTER ROLE x6.
- Step 5: `ok` for ledger, identity, org, billing, legal, addons, notify, audit, agent; org at 8 migrations (0008 creates org.institution_application and org.institution_application_event).
- Step 6: INSERT 0 1; SET; INSERT 0 1; SET; INSERT 0 1.
- Step 7: INSERT 0 1; SET; `ERROR: duplicate key value violates unique constraint "institution_application_applicant_party_id_key"` (Key (applicant_party_id)=(...0632a0) already exists).
- Step 8: SET; `ERROR: permission denied for table institution_application`.
- Step 9: one row `Handoff Yeshiva | submitted`.
