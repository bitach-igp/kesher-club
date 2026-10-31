Task: T-0643 · Branch: claude/practical-babbage-80xevv · Needs: docker
Why: Migration org/0010 adds staff invites and their acceptances (REQ-INS-020). This applies it on real Postgres 16 and checks four things. The app role can record an invite and accept it once. A second acceptance of the same invite is refused. The app role cannot update an invite. Each statement whose success another depends on is in its own `-c` call. Nothing here is real data; the hashes are placeholders.
Steps (from repo root, PowerShell on Windows unless stated):
1. $OutputEncoding = New-Object System.Text.UTF8Encoding $false
2. docker run --name kesher-pg -e POSTGRES_PASSWORD=postgres -e POSTGRES_DB=club -p 5433:5432 -d postgres:16
3. Start-Sleep -Seconds 8
4. Get-Content -Raw db/roles.sql | docker exec -i kesher-pg psql -U postgres -d club -v ON_ERROR_STOP=1
5. node db/migrate.mjs --docker --url "postgres://postgres:postgres@localhost:5433/club?sslmode=disable"
6. docker exec -i kesher-pg psql -U postgres -d club -c "insert into org.institution (id, name, market) values ('00000000-0000-7000-8000-000000064301', 'Handoff Yeshiva', 'IL')" -c "set role club_app; insert into org.staff_invite (id, institution_id, idempotency_key, role, channel, recipient_hash, token_hash, invited_by, sent_at, expires_at) values ('00000000-0000-7000-8000-000000064302', '00000000-0000-7000-8000-000000064301', 't0643-invite', 'finance', 'email', 'hash-recipient', 'hash-token', '00000000-0000-7000-8000-0000000643a0', now(), now() + interval '7 days')" -c "set role club_app; insert into org.staff_invite_acceptance (invite_id, party_id, accepted_at) values ('00000000-0000-7000-8000-000000064302', '00000000-0000-7000-8000-0000000643b0', now())"
7. docker exec -i kesher-pg psql -U postgres -d club -c "set role club_app; insert into org.staff_invite_acceptance (invite_id, party_id, accepted_at) values ('00000000-0000-7000-8000-000000064302', '00000000-0000-7000-8000-0000000643c0', now())"
8. docker exec -i kesher-pg psql -U postgres -d club -c "set role club_app; update org.staff_invite set role = 'admin' where id = '00000000-0000-7000-8000-000000064302'"
9. docker exec -i kesher-pg psql -U postgres -d club -c "select i.role, a.party_id from org.staff_invite i join org.staff_invite_acceptance a on a.invite_id = i.id"
10. docker rm -f kesher-pg
Expected: step 5 prints `ok` for every schema, with org at 10 migrations. Step 6 prints `INSERT 0 1`, then `SET` and `INSERT 0 1` twice. Step 7 prints `SET` and an error: duplicate key value violates unique constraint `staff_invite_acceptance_pkey`. Step 8 prints `SET` and `ERROR: permission denied for table staff_invite`. Step 9 prints one row: `finance | 00000000-0000-7000-8000-0000000643b0`.
Report back: the console output of steps 5 to 9.
