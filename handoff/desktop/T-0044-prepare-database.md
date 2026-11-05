Task: T-0044 · Branch: card/T-0044 · Needs: docker
Why: the migrate image and `db/prepare.mjs` run roles, passwords, grants and every schema against a real Postgres 16 as a NON-superuser master (like RDS); the cloud session only has PGlite and no Docker daemon.
Steps (from repo root, PowerShell on Windows unless stated; every password below is a throwaway for this local container):
1. docker run --name kesher-pg -e POSTGRES_PASSWORD=postgres -p 5433:5432 -d postgres:16
2. docker exec kesher-pg psql -U postgres -c "create role master login createrole createdb password 'masterpw'"
3. docker exec kesher-pg psql -U postgres -c "create database club owner master"
4. docker build -f tools/migrate/Dockerfile -t kesher-migrate:local .
5. docker run --rm --add-host=host.docker.internal:host-gateway -e PGHOST=host.docker.internal -e PGPORT=5433 -e PGDATABASE=club -e PGSSLMODE=disable -e PGUSER=master -e PGPASSWORD=masterpw -e DB_APP_PASSWORD=app-pw-1 -e DB_JIT_PASSWORD=jit-pw-1 -e DB_READONLY_PASSWORD=ro-pw-1 "-e DB_MIGRATOR_PASSWORD=mig/pw:1" kesher-migrate:local
6. Run step 5 again unchanged.
7. docker exec -e PGPASSWORD=app-pw-1 kesher-pg psql -h 127.0.0.1 -U club_app -d club -c "select count(*) from ledger.journal"
8. docker exec -e PGPASSWORD=jit-pw-1 kesher-pg psql -h 127.0.0.1 -U club_jit -d club -c "select 1"
9. docker exec -e PGPASSWORD=ro-pw-1 kesher-pg psql -h 127.0.0.1 -U club_readonly -d club -c "select 1"
10. docker exec -e PGPASSWORD=app-pw-1 kesher-pg psql -h 127.0.0.1 -U club_app -d club -c "delete from ledger.journal"
11. docker rm -f kesher-pg
Expected: step 5 prints `ok   roles`, `ok   passwords and grants`, `ok   migrate` and every schema applies; step 6 prints the same three `ok` lines and exits 0 (idempotent); steps 7 to 9 succeed (each role can log in, which fails today because roles.sql revokes CONNECT from PUBLIC); step 10 is refused with `permission denied` (the ledger is insert-only for club_app). None of `masterpw`, `app-pw-1`, `jit-pw-1`, `ro-pw-1`, `mig/pw:1` appears in the output of steps 4 to 6.
Report back: the console output of steps 5 to 10 (trimmed), and whether any of the five passwords appeared in it.
