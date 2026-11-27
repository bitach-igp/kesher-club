Task: T-1104 · Branch: card/T-1104 · Needs: docker
Why: Migration ledger/0035 adds ops.recipient_invite (a status column the app may change through a column-level update grant, a unique index that allows one live invite per sender and phone, check constraints) and ops.recipient_invite_event (insert-only history, unique per invite and state). The invite service takes `pg_advisory_xact_lock(hashtextextended('recipient-invite:' || sender_party_id, 0))` to judge the daily cap and "one live invite per sender and phone", and its claim and join steps are conditional updates; PGlite has one connection, so two simultaneous invites and a claim race can only be shown on real Postgres 16 under READ COMMITTED. Each statement whose success another depends on is in its own `-c`; a `-c` holding several statements is one transaction, so every deliberately failing statement is alone in its `-c` (steps 10 to 13, 15 to 19 and 21). The concurrency steps run two psql sessions from PowerShell jobs. Nothing here is a real person: the phone columns hold made-up bytes. No text is sent.
Steps (from repo root, PowerShell on Windows unless stated):
1. docker run --name kesher-pg -e POSTGRES_PASSWORD=postgres -e POSTGRES_DB=club -p 5433:5432 -d postgres:16
2. Start-Sleep -Seconds 8
3. Get-Content -Raw db/roles.sql | docker exec -i kesher-pg psql -U postgres -d club -v ON_ERROR_STOP=1
4. node db/migrate.mjs --docker --url "postgres://postgres:postgres@localhost:5433/club?sslmode=disable"
5. node db/migrate.mjs --docker --url "postgres://postgres:postgres@localhost:5433/club?sslmode=disable"
6. docker exec -i kesher-pg psql -U postgres -d club -c "select count(*) as migrations, max(version) as latest from atlas_ledger.atlas_schema_revisions"
7. docker exec -i kesher-pg psql -U postgres -d club -c "show default_transaction_isolation"
8. docker exec -i kesher-pg psql -U postgres -d club -c "set role club_app; insert into ops.recipient_invite (id, sender_party_id, phone_index, phone_sealed, amount_hint_minor, amount_hint_currency, category, status, created_at, expires_at, updated_at) values ('00000000-0000-7000-8000-000000110401', '00000000-0000-7000-8000-000000110499', decode(repeat('ab', 32), 'hex'), decode('01', 'hex'), 50000, 'ILS', 'soldier', 'open', now(), now() + interval '14 days', now())"
9. docker exec -i kesher-pg psql -U postgres -d club -c "set role club_app; insert into ops.recipient_invite_event (invite_id, from_status, to_status, at) values ('00000000-0000-7000-8000-000000110401', null, 'open', now())"
10. docker exec -i kesher-pg psql -U postgres -d club -c "set role club_app; insert into ops.recipient_invite (id, sender_party_id, phone_index, phone_sealed, status, created_at, expires_at, updated_at) values ('00000000-0000-7000-8000-000000110402', '00000000-0000-7000-8000-000000110499', decode(repeat('ab', 32), 'hex'), decode('01', 'hex'), 'open', now(), now() + interval '14 days', now())"
11. docker exec -i kesher-pg psql -U postgres -d club -c "set role club_app; insert into ops.recipient_invite (id, sender_party_id, phone_index, phone_sealed, amount_hint_minor, status, created_at, expires_at, updated_at) values ('00000000-0000-7000-8000-000000110403', '00000000-0000-7000-8000-000000110499', decode(repeat('ac', 32), 'hex'), decode('01', 'hex'), 5, 'open', now(), now() + interval '14 days', now())"
12. docker exec -i kesher-pg psql -U postgres -d club -c "set role club_app; insert into ops.recipient_invite (id, sender_party_id, phone_index, phone_sealed, category, status, created_at, expires_at, updated_at) values ('00000000-0000-7000-8000-000000110404', '00000000-0000-7000-8000-000000110499', decode(repeat('ad', 32), 'hex'), decode('01', 'hex'), 'prince', 'open', now(), now() + interval '14 days', now())"
13. docker exec -i kesher-pg psql -U postgres -d club -c "set role club_app; insert into ops.recipient_invite (id, sender_party_id, phone_index, phone_sealed, status, created_at, expires_at, updated_at) values ('00000000-0000-7000-8000-000000110405', '00000000-0000-7000-8000-000000110499', decode(repeat('ae', 32), 'hex'), decode('01', 'hex'), 'claimable', now(), now() + interval '14 days', now())"
14. docker exec -i kesher-pg psql -U postgres -d club -c "set role club_app; update ops.recipient_invite set status = 'claimable', recipient_party_id = '00000000-0000-7000-8000-000000110498', updated_at = now() where id = '00000000-0000-7000-8000-000000110401'"
14a. docker exec -i kesher-pg psql -U postgres -d club -c "set role club_app; update ops.recipient_invite set sender_told_at = now(), reconciled_at = now() where id = '00000000-0000-7000-8000-000000110401'"
15. docker exec -i kesher-pg psql -U postgres -d club -c "set role club_app; update ops.recipient_invite set sender_party_id = '00000000-0000-7000-8000-000000110497' where id = '00000000-0000-7000-8000-000000110401'"
16. docker exec -i kesher-pg psql -U postgres -d club -c "set role club_app; update ops.recipient_invite set phone_index = decode(repeat('00', 32), 'hex') where id = '00000000-0000-7000-8000-000000110401'"
17. docker exec -i kesher-pg psql -U postgres -d club -c "set role club_app; delete from ops.recipient_invite where id = '00000000-0000-7000-8000-000000110401'"
18. docker exec -i kesher-pg psql -U postgres -d club -c "set role club_app; update ops.recipient_invite_event set to_status = 'expired' where invite_id = '00000000-0000-7000-8000-000000110401'"
19. docker exec -i kesher-pg psql -U postgres -d club -c "set role club_app; delete from ops.recipient_invite_event where invite_id = '00000000-0000-7000-8000-000000110401'"
20. docker exec -i kesher-pg psql -U postgres -d club -c "set role club_app; insert into ops.recipient_invite_event (invite_id, from_status, to_status, at) values ('00000000-0000-7000-8000-000000110401', 'open', 'claimable', now())"
21. docker exec -i kesher-pg psql -U postgres -d club -c "set role club_app; insert into ops.recipient_invite_event (invite_id, from_status, to_status, at) values ('00000000-0000-7000-8000-000000110401', 'open', 'claimable', now())"
22. docker exec -i kesher-pg psql -U postgres -d club -c "set role club_app; begin; select current_setting('transaction_isolation') as isolation; select pg_advisory_xact_lock(hashtextextended('recipient-invite:' || '00000000-0000-7000-8000-000000110499', 0)); commit;"
23. Two invites by one sender at once, with the lock the service takes. Session A holds the lock four seconds, session B starts a second later and must wait, then (under READ COMMITTED, its insert statement takes a new snapshot after the lock) finds A's row and inserts nothing. Run all of step 23 as one block:
    $mk = { param($id) docker exec -i kesher-pg psql -U postgres -d club -c "set role club_app; begin; select current_setting('transaction_isolation') as isolation; select pg_advisory_xact_lock(hashtextextended('recipient-invite:' || '00000000-0000-7000-8000-000000110496', 0)); select pg_sleep(4); insert into ops.recipient_invite (id, sender_party_id, phone_index, phone_sealed, status, created_at, expires_at, updated_at) select '$id', '00000000-0000-7000-8000-000000110496', decode(repeat('cd', 32), 'hex'), decode('01', 'hex'), 'open', now(), now() + interval '14 days', now() where not exists (select 1 from ops.recipient_invite where sender_party_id = '00000000-0000-7000-8000-000000110496' and phone_index = decode(repeat('cd', 32), 'hex') and status in ('open', 'claimable')); commit;" }
    $a = Start-Job -ScriptBlock $mk -ArgumentList '00000000-0000-7000-8000-00000011040a'
    Start-Sleep -Seconds 1
    $b = Start-Job -ScriptBlock $mk -ArgumentList '00000000-0000-7000-8000-00000011040b'
    Wait-Job $a, $b | Out-Null
    Receive-Job $a, $b
24. docker exec -i kesher-pg psql -U postgres -d club -c "select count(*) as live_invites from ops.recipient_invite where sender_party_id = '00000000-0000-7000-8000-000000110496' and status in ('open', 'claimable')"
25. The same race with no lock, to show the unique index is the backstop. Session A inserts and holds its transaction open four seconds; session B inserts the same sender and phone a second later and waits on the index. Run as one block:
    $nolock = { param($id) docker exec -i kesher-pg psql -U postgres -d club -c "set role club_app; begin; insert into ops.recipient_invite (id, sender_party_id, phone_index, phone_sealed, status, created_at, expires_at, updated_at) values ('$id', '00000000-0000-7000-8000-000000110495', decode(repeat('ef', 32), 'hex'), decode('01', 'hex'), 'open', now(), now() + interval '14 days', now()); select pg_sleep(4); commit;" }
    $a = Start-Job -ScriptBlock $nolock -ArgumentList '00000000-0000-7000-8000-00000011040c'
    Start-Sleep -Seconds 1
    $b = Start-Job -ScriptBlock $nolock -ArgumentList '00000000-0000-7000-8000-00000011040d'
    Wait-Job $a, $b | Out-Null
    Receive-Job $a, $b
26. A claim race on one claimable invite. First make the invite, then run the two claims. Step 26a:
    docker exec -i kesher-pg psql -U postgres -d club -c "set role club_app; insert into ops.recipient_invite (id, sender_party_id, phone_index, phone_sealed, status, recipient_party_id, created_at, expires_at, updated_at) values ('00000000-0000-7000-8000-00000011040e', '00000000-0000-7000-8000-000000110494', decode(repeat('f0', 32), 'hex'), decode('01', 'hex'), 'claimable', '00000000-0000-7000-8000-000000110493', now(), now() + interval '14 days', now())"
    Step 26b, one block: the first claim updates the row and holds its transaction four seconds; the second waits on the row lock, re-reads the row when the first commits (READ COMMITTED), no longer matches `status = 'claimable'`, updates nothing and so inserts no history row:
    $claim = { docker exec -i kesher-pg psql -U postgres -d club -c "set role club_app; begin; select current_setting('transaction_isolation') as isolation; with won as (update ops.recipient_invite set status = 'claimed', phone_sealed = null, updated_at = now() where id = '00000000-0000-7000-8000-00000011040e' and status = 'claimable' returning id) insert into ops.recipient_invite_event (invite_id, from_status, to_status, at) select id, 'claimable', 'claimed', now() from won; select pg_sleep(4); commit;" }
    $a = Start-Job -ScriptBlock $claim
    Start-Sleep -Seconds 1
    $b = Start-Job -ScriptBlock $claim
    Wait-Job $a, $b | Out-Null
    Receive-Job $a, $b
27. docker exec -i kesher-pg psql -U postgres -d club -c "select to_status, count(*) from ops.recipient_invite_event where invite_id = '00000000-0000-7000-8000-00000011040e' group by to_status order by to_status"
28. docker exec -i kesher-pg psql -U postgres -d club -c "select status, phone_sealed is null as sealed_cleared from ops.recipient_invite where id = '00000000-0000-7000-8000-00000011040e'"
29. docker rm -f kesher-pg
Expected: step 4 prints `ok` for every schema, ledger at 35 migrations; step 5 reports no pending migrations. Step 6 prints 35 and 0035. Step 7 prints `read committed`. Steps 8 and 9 print `INSERT 0 1`. Step 10 fails with `duplicate key value violates unique constraint "recipient_invite_live"` (one live invite per sender and phone). Step 11 fails with a check constraint violation (a hint needs both an amount and a currency). Step 12 fails with a check constraint violation on category. Step 13 fails with a check constraint violation (a claimable invite needs a recipient). Steps 14 and 14a print `UPDATE 1` (the app role may set the status, the recipient, the sealed phone, the notice and the check time). Steps 15, 16 and 17 fail with `permission denied for table recipient_invite` (who, which phone and deleting are never granted). Steps 18 and 19 fail with `permission denied for table recipient_invite_event`. Step 20 prints `INSERT 0 1` and step 21 fails with `duplicate key value violates unique constraint` (a state is entered once). Step 22 prints `read committed`, one row with an empty `pg_advisory_xact_lock`, and `COMMIT`. Step 23: both sessions print `read committed`; the job that took the lock first prints `INSERT 0 1`, the other waits about four seconds and prints `INSERT 0 0`; step 24 prints 1. Step 25: the first job prints `COMMIT`, the second fails with `duplicate key value violates unique constraint "recipient_invite_live"`. Step 26a prints `INSERT 0 1`; in 26b both sessions print `read committed`, one prints `INSERT 0 1`, the other `INSERT 0 0`; step 27 prints one row, `claimed | 1`; step 28 prints `claimed | t`.
Report back: the console output of steps 4, 6, 7, 10 to 14a and 15 to 28.

## Result
Outcome: PASS, every step as expected. Run 2026-11-27 14:09 (Asia/Jerusalem) by the desktop checker on Zvi's PC, runner worktree at 7b86604, Docker 29.9.3, postgres:16 on port 5433; container removed at the end.
- Step 4: `Migrating to version 0035 (35 migrations in total)` for ledger; `ok` for ledger, identity, org, billing, legal, addons, notify, audit, agent. Step 5: `No migration files to execute`, `ok` for each.
- Step 6: `35 | 0035`. Step 7: `read committed`.
- Steps 8, 9: `INSERT 0 1`.
- Step 10: `duplicate key value violates unique constraint "recipient_invite_live"`.
- Step 11: `violates check constraint "recipient_invite_check"` (amount without currency).
- Step 12: `violates check constraint "recipient_invite_category_check"`.
- Step 13: `violates check constraint "recipient_invite_check1"` (claimable without recipient).
- Steps 14, 14a: `UPDATE 1`.
- Steps 15, 16, 17: `permission denied for table recipient_invite`. Steps 18, 19: `permission denied for table recipient_invite_event`.
- Step 20: `INSERT 0 1`. Step 21: `duplicate key value violates unique constraint "recipient_invite_event_invite_id_to_status_key"`.
- Step 22: `read committed`, empty `pg_advisory_xact_lock` row, `COMMIT`.
- Step 23: both `read committed`; job A `INSERT 0 1`, `COMMIT`; job B (waited on the lock) `INSERT 0 0`, `COMMIT`. Step 24: `live_invites 1`.
- Step 25: job A `INSERT 0 1`, `COMMIT`; job B `duplicate key value violates unique constraint "recipient_invite_live"`.
- Step 26a: `INSERT 0 1`. Step 26b: both `read committed`; job A `INSERT 0 1`, `COMMIT`; job B `INSERT 0 0`, `COMMIT`.
- Step 27: `claimed | 1`. Step 28: `claimed | t`.
- Step 29: `kesher-pg` removed.
