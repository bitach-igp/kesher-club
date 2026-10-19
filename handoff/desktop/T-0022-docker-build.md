Task: T-0022 · Branch: claude/practical-babbage-80xevv · Needs: docker
Why: apps/worker/Dockerfile is new and the cloud session has the docker CLI but no daemon, so the image build and a container boot go on the PC. The cloud session already proved the same layout works without Docker: a filtered production install from a clean context ran two worker processes against a real Postgres 16, each of the 14 jobs ran exactly once between them (the other task skipped on the lock), and both exited 0 on SIGTERM. Nothing here uses a secret or a member's data.
Steps (from repo root, PowerShell on Windows unless stated):
1. git rev-parse --short HEAD
2. docker build -f apps/worker/Dockerfile -t kesher/worker:t0022 .
3. docker run --rm kesher/worker:t0022 id -un
4. docker run --rm kesher/worker:t0022 node --experimental-strip-types --disable-warning=ExperimentalWarning src/index.ts
5. docker run --rm kesher/worker:t0022 sh -c "test -L /app/apps/worker/node_modules/@kesher/api && readlink -f /app/apps/worker/node_modules/@kesher/api && test ! -e /app/apps/worker/node_modules/@electric-sql/pglite-socket && echo dev-deps-excluded"
6. docker image rm kesher/worker:t0022
Expected: step 2 finishes with the image tagged kesher/worker:t0022. Step 3 prints `node` (the container does not run as root). Step 4 exits with code 1 and prints one JSON line with "service":"worker","event":"boot_failed","error":"ConfigError" naming the missing keys (APP_ENV, DATABASE_URL, JWT_SIGNING_KEY, PII_DATA_KEY and the rest): no stack trace and no value. Step 5 prints `/app/apps/api` then `dev-deps-excluded`.
Report back: the last 20 lines of step 2, and the full output of steps 3, 4 and 5.
