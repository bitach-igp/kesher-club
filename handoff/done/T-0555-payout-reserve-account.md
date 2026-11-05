Task: T-0555 · Branch: card/T-0555 · Needs: docker
Why: the ledger migration adds an enum value (`payout_reserve` to `ledger.account_type`). A new enum value cannot be used in the transaction that adds it, and the repo has no precedent for it, so the migration has to be shown to apply on real Postgres 16 and the value to be usable in a later statement. PGlite applies it, but is not the production engine.
Steps (from repo root, PowerShell on Windows unless stated):
1. docker run --name kesher-pg -e POSTGRES_PASSWORD=postgres -e POSTGRES_DB=club -p 5433:5432 -d postgres:16
2. Start-Sleep -Seconds 8
3. Get-Content -Raw db/roles.sql | docker exec -i kesher-pg psql -U postgres -d club -v ON_ERROR_STOP=1
4. node db/migrate.mjs --docker --url "postgres://postgres:postgres@localhost:5433/club?sslmode=disable"
5. docker exec kesher-pg psql -U postgres -d club -c "select unnest(enum_range(null::ledger.account_type))"
6. docker exec kesher-pg psql -U postgres -d club -c "insert into ledger.account (id, owner_party_id, type, currency, normal_side) values (gen_random_uuid(), gen_random_uuid(), 'payout_reserve', 'ILS', 'C') returning type"
7. docker rm -f kesher-pg
Expected: step 4 prints `ok` for every schema (ledger applies 0027). Step 5 lists `payout_reserve` as the last value. Step 6 prints one row with `payout_reserve` (the value is usable in a later statement).
Report back: the console output of steps 4, 5 and 6, and `docker --version`.
