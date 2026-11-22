Task: T-0768 · Branch: cards/T-0768-workflow-marker-table · Needs: docker
Why: Migration ledger/0033 adds ops.workflow_marker, our own write-once workflow markers (primary key (kind, subject_id, seq), unique (kind, value), check (seq >= 0)). club_app may select and insert but not update or delete. The cloud session only has PGlite. Each statement whose success another depends on is in its own `-c` call, and each deliberately failing insert is in its own `-c` so it rolls back nothing else. Nothing here is a real member or key.
Steps (from repo root, PowerShell on Windows unless stated):
1. docker run --name kesher-pg -e POSTGRES_PASSWORD=postgres -e POSTGRES_DB=club -p 5433:5432 -d postgres:16
2. Start-Sleep -Seconds 8
3. Get-Content -Raw db/roles.sql | docker exec -i kesher-pg psql -U postgres -d club -v ON_ERROR_STOP=1
4. node db/migrate.mjs --docker --url "postgres://postgres:postgres@localhost:5433/club?sslmode=disable"
5. node db/migrate.mjs --docker --url "postgres://postgres:postgres@localhost:5433/club?sslmode=disable"
6. docker exec -i kesher-pg psql -U postgres -d club -c "set role club_app; insert into ops.workflow_marker (kind, subject_id, seq, value) values ('membership_lost_key', '00000000-0000-7000-8000-000000076800', 0, 'check-key-076800')"
7. docker exec -i kesher-pg psql -U postgres -d club -c "set role club_app; insert into ops.workflow_marker (kind, subject_id, seq, value) values ('membership_lost_key', '00000000-0000-7000-8000-000000076800', 0, 'check-key-076801') on conflict do nothing"
8. docker exec -i kesher-pg psql -U postgres -d club -c "set role club_app; insert into ops.workflow_marker (kind, subject_id, seq, value) values ('membership_lost_key', '00000000-0000-7000-8000-000000076801', 0, 'check-key-076800')"
9. docker exec -i kesher-pg psql -U postgres -d club -c "set role club_app; insert into ops.workflow_marker (kind, subject_id, seq, value) values ('credit_began', '00000000-0000-7000-8000-000000076802', -1, 'check-key-076802')"
10. docker exec -i kesher-pg psql -U postgres -d club -c "set role club_app; select kind, subject_id, seq, value from ops.workflow_marker"
11. docker exec -i kesher-pg psql -U postgres -d club -c "set role club_app; update ops.workflow_marker set value = 'changed' where kind = 'membership_lost_key'"
12. docker exec -i kesher-pg psql -U postgres -d club -c "set role club_app; delete from ops.workflow_marker"
13. docker rm -f kesher-pg
Expected: step 4 prints `ok` for every schema, with ledger at 33 migrations. Step 5 reports no pending migrations. Step 6 prints `INSERT 0 1`. Step 7 prints `INSERT 0 0` (the primary key repeats; the first value is kept). Step 8 fails with a duplicate key violation on `workflow_marker_kind_value_key` (the same value for another subject under the same kind). Step 9 fails with a check violation on `workflow_marker_seq_check`. Step 10 prints one row, `membership_lost_key | ...76800 | 0 | check-key-076800`. Step 11 fails with `permission denied for table workflow_marker`. Step 12 fails with `permission denied for table workflow_marker`.
Report back: the console output of steps 4 to 12.
