Task: T-0652 · Branch: claude/practical-babbage-80xevv · Needs: docker
Why: Migration org/0013 adds `org.fee_us_collect` (the fee items collected on the provider's payment page) and `org.fee_external_payment` (the insert-only record of what the provider says was paid or refunded, REQ-INS-023). This applies it on real Postgres 16 and checks four things. The app role can append rows. A provider payment ref can be written once per kind. A kind outside payment and refund is refused. The app role cannot update or delete a payment row. Each statement whose success another depends on is in its own `-c` call. Nothing here is real data.
Steps (from repo root, PowerShell on Windows unless stated):
1. $OutputEncoding = New-Object System.Text.UTF8Encoding $false
2. docker run --name kesher-pg -e POSTGRES_PASSWORD=postgres -e POSTGRES_DB=club -p 5433:5432 -d postgres:16
3. Start-Sleep -Seconds 8
4. Get-Content -Raw db/roles.sql | docker exec -i kesher-pg psql -U postgres -d club -v ON_ERROR_STOP=1
5. node db/migrate.mjs --docker --url "postgres://postgres:postgres@localhost:5433/club?sslmode=disable"
6. docker exec -i kesher-pg psql -U postgres -d club -c "insert into org.institution (id, name, market) values ('00000000-0000-7000-8000-000000065201', 'Handoff School', 'US')" -c "insert into org.fee_batch (id, idempotency_key, institution_id, description, amount_minor, currency, due_at, member_count, request_hash, created_by, created_at) values ('00000000-0000-7000-8000-000000065202', 't0652-batch-01', '00000000-0000-7000-8000-000000065201', 'Tuition', 25000, 'USD', '2026-12-01', 1, 'h', '00000000-0000-7000-8000-000000065209', now())" -c "insert into org.fee_item (id, institution_id, member_party_id, description, amount_minor, currency, status, due_at, created_at, batch_id) values ('00000000-0000-7000-8000-000000065203', '00000000-0000-7000-8000-000000065201', '00000000-0000-7000-8000-000000065209', 'Tuition', 25000, 'USD', 'due', '2026-12-01', now(), '00000000-0000-7000-8000-000000065202')" -c "set role club_app; insert into org.fee_us_collect (fee_item_id, institution_id, batch_id, requested_by, created_at) values ('00000000-0000-7000-8000-000000065203', '00000000-0000-7000-8000-000000065201', '00000000-0000-7000-8000-000000065202', '00000000-0000-7000-8000-000000065209', now())" -c "set role club_app; insert into org.fee_external_payment (id, fee_item_id, kind, provider_payment_ref, amount_minor, currency, at) values ('00000000-0000-7000-8000-000000065204', '00000000-0000-7000-8000-000000065203', 'payment', 'pay_t0652_1', 25000, 'USD', now())"
7. docker exec -i kesher-pg psql -U postgres -d club -c "set role club_app; insert into org.fee_external_payment (id, fee_item_id, kind, provider_payment_ref, amount_minor, currency, at) values ('00000000-0000-7000-8000-000000065205', '00000000-0000-7000-8000-000000065203', 'payment', 'pay_t0652_1', 25000, 'USD', now())"
8. docker exec -i kesher-pg psql -U postgres -d club -c "set role club_app; insert into org.fee_external_payment (id, fee_item_id, kind, provider_payment_ref, amount_minor, currency, at) values ('00000000-0000-7000-8000-000000065206', '00000000-0000-7000-8000-000000065203', 'refund', 'pay_t0652_1', 25000, 'USD', now())"
9. docker exec -i kesher-pg psql -U postgres -d club -c "set role club_app; insert into org.fee_external_payment (id, fee_item_id, kind, provider_payment_ref, amount_minor, currency, at) values ('00000000-0000-7000-8000-000000065207', '00000000-0000-7000-8000-000000065203', 'bogus', 'pay_t0652_2', 25000, 'USD', now())"
10. docker exec -i kesher-pg psql -U postgres -d club -c "set role club_app; update org.fee_external_payment set amount_minor = 1 where id = '00000000-0000-7000-8000-000000065204'"
11. docker exec -i kesher-pg psql -U postgres -d club -c "set role club_app; delete from org.fee_external_payment where id = '00000000-0000-7000-8000-000000065204'"
12. docker exec -i kesher-pg psql -U postgres -d club -c "select kind, provider_payment_ref from org.fee_external_payment order by seq"
13. docker rm -f kesher-pg
Expected: step 5 prints `ok` for every schema, with org at 13 migrations. Step 6 prints `INSERT 0 1` for the institution, the batch and the item, then `SET` and `INSERT 0 1` twice. Step 7 prints `SET` and `ERROR: duplicate key value violates unique constraint` (a payment ref is written once per kind). Step 8 prints `SET` and `INSERT 0 1` (a refund of the same ref is a different kind). Step 9 prints `SET` and `ERROR: new row for relation "fee_external_payment" violates check constraint`. Steps 10 and 11 each print `SET` and `ERROR: permission denied for table fee_external_payment`. Step 12 prints two rows: `payment | pay_t0652_1` and `refund | pay_t0652_1`.
Report back: the console output of steps 5 to 12.

## Result
PASS, 2026-11-03 16:07 (Asia/Jerusalem), by the desktop checker on Zvi's PC. Runner worktree at da5ba14, Docker 29.8.2, postgres:16.
- Step 5: `ok` for all nine schemas; org at 13 migrations.
- Step 6: `INSERT 0 1` three times (institution, batch, item), then `SET` / `INSERT 0 1` twice.
- Step 7: `SET`, `ERROR:  duplicate key value violates unique constraint "fee_external_payment_provider_payment_ref_kind_key"` (Key (provider_payment_ref, kind)=(pay_t0652_1, payment) already exists).
- Step 8: `SET`, `INSERT 0 1`.
- Step 9: `SET`, `ERROR:  new row for relation "fee_external_payment" violates check constraint "fee_external_payment_kind_check"`.
- Steps 10 and 11: `SET`, `ERROR:  permission denied for table fee_external_payment` each.
- Step 12: `payment | pay_t0652_1`, `refund | pay_t0652_1` (2 rows).
- Step 13: container removed.
