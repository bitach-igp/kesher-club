Task: T-0687 · Branch: card/T-0687 · Needs: docker
Why: the cloud has no real Postgres; PGlite runs one connection, so only a real server shows two claimers skipping each other's locked rows.
Steps (from repo root, PowerShell on Windows unless stated; a throwaway Postgres 16 container, removed at the end):
1. docker run -d --name t0687-pg -e POSTGRES_PASSWORD=pw -p 55687:5432 postgres:16
2. docker exec t0687-pg pg_isready -U postgres
3. atlas migrate apply --dir file://db/migrations/ledger --url "postgres://postgres:pw@localhost:55687/postgres?sslmode=disable"
4. docker exec t0687-pg psql -U postgres -c "select column_name, data_type, is_nullable, column_default from information_schema.columns where table_schema = 'ops' and table_name = 'outbox' and column_name in ('attempts', 'last_error_class') order by 1"
5. docker exec t0687-pg psql -U postgres -c "insert into ops.outbox (aggregate, aggregate_id, type, payload) select 'test', '00000000-0000-7000-8000-000000000687', 'claim.' || g, '{}' from generate_series(1, 4) g"
6. docker exec -d t0687-pg psql -U postgres -c "begin; select id from ops.outbox where published_at is null order by id limit 2 for update skip locked; select pg_sleep(8); commit;"
7. docker exec t0687-pg psql -U postgres -c "begin; select id from ops.outbox where published_at is null order by id limit 2 for update skip locked; commit;"
8. docker exec t0687-pg psql -U postgres -c "select count(*) as unpublished from ops.outbox where published_at is null"
9. docker rm -f t0687-pg
Expected: step 3 applies 0031 cleanly; step 4 lists `attempts integer NO 0` and `last_error_class text YES`; step 7 (run within 8 s of step 6, which holds ids 1 and 2) returns the other two ids (3 and 4), never 1 or 2; step 8 prints 4.
Report back: the output of steps 3, 4, 7 and 8.
