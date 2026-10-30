Task: T-1014 · Branch: claude/practical-babbage-80xevv · Needs: docker
Why: Migration agent/0002 adds agent.authorization_request and agent.refresh_token for the in-house MCP authorization server (ADR-009). A request's PKCE challenge must be 43 base64url characters, and an approved request must carry who approved, the grant and the code's hash. club_app may insert and update but not delete. This needs the real Postgres 16 apply; the cloud session only has PGlite. Each statement whose success another depends on is in its own `-c` call. Nothing here is a real client or member.
Steps (from repo root, PowerShell on Windows unless stated):
1. docker run --name kesher-pg -e POSTGRES_PASSWORD=postgres -e POSTGRES_DB=club -p 5433:5432 -d postgres:16
2. Start-Sleep -Seconds 8
3. Get-Content -Raw db/roles.sql | docker exec -i kesher-pg psql -U postgres -d club -v ON_ERROR_STOP=1
4. node db/migrate.mjs --docker --url "postgres://postgres:postgres@localhost:5433/club?sslmode=disable"
5. node db/migrate.mjs --docker --url "postgres://postgres:postgres@localhost:5433/club?sslmode=disable"
6. docker exec -i kesher-pg psql -U postgres -d club -c "insert into agent.client (client_id, name, metadata, fetched_at) values ('https://assistant.example/client.json', 'T-1014 check', '{}', now())"
7. docker exec -i kesher-pg psql -U postgres -d club -c "set role club_app; insert into agent.authorization_request (id, client_id, redirect_uri, scopes, state, code_challenge, resource, created_at, expires_at) values ('00000000-0000-7000-8000-000000101400', 'https://assistant.example/client.json', 'https://assistant.example/cb', '{balances:read}', 'xyz', 'E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM', 'https://api.kesher.example/mcp', now(), now() + interval '10 minutes')"
8. docker exec -i kesher-pg psql -U postgres -d club -c "set role club_app; insert into agent.authorization_request (id, client_id, redirect_uri, scopes, state, code_challenge, resource, created_at, expires_at) values ('00000000-0000-7000-8000-000000101401', 'https://assistant.example/client.json', 'https://assistant.example/cb', '{balances:read}', 'xyz', 'plain', 'https://api.kesher.example/mcp', now(), now())"
9. docker exec -i kesher-pg psql -U postgres -d club -c "set role club_app; update agent.authorization_request set status = 'approved' where id = '00000000-0000-7000-8000-000000101400'"
10. docker exec -i kesher-pg psql -U postgres -d club -c "set role club_app; delete from agent.authorization_request"
11. docker rm -f kesher-pg
Expected: step 4 prints `ok` for every schema, with agent at 2 migrations. Step 5 reports no pending migrations. Step 6 prints `INSERT 0 1`. Step 7 prints `INSERT 0 1`. Step 8 fails with a check constraint violation (the challenge). Step 9 fails with a check constraint violation (approved without a grant or code). Step 10 fails with `permission denied for table authorization_request`.
Report back: the console output of steps 4 to 10.

## Result
PASS, 2026-10-30 03:15 (Asia/Jerusalem), Kesher desktop checker on Zvi's PC. Runner worktree at edaba66 (main), Docker 29.8.2, postgres:16.

- Step 3 (roles.sql): exit 0.
- Step 4: exit 0; `ok` for ledger, identity, org, billing, legal, addons, notify, audit, agent. agent migrated to version 0002 (2 migrations).
- Step 5: exit 0; "No migration files to execute" for all nine schemas, `ok` for all nine.
- Step 6: `INSERT 0 1`.
- Step 7: `SET` / `INSERT 0 1`.
- Step 8: `ERROR:  new row for relation "authorization_request" violates check constraint "authorization_request_code_challenge_check"`.
- Step 9: `ERROR:  new row for relation "authorization_request" violates check constraint "authorization_request_check"` (row status approved, grant/code columns null).
- Step 10: `ERROR:  permission denied for table authorization_request`.
- Step 11: container `kesher-pg` removed.
