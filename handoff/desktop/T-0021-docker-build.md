Task: T-0021 · Branch: claude/practical-babbage-80xevv · Needs: docker
Why: apps/api/Dockerfile is new and the cloud session has the docker CLI but no daemon, so the image build and a container boot go on the PC. The cloud session already proved the same layout works without Docker (a filtered production install from a clean context booted under plain Node, answered /v1/status 200 and exited 0 on SIGTERM). The values below are throwaway test keys generated on the spot; nothing here is a real secret or a real member.
Steps (from repo root, PowerShell on Windows unless stated):
1. git rev-parse --short HEAD
2. docker build -f apps/api/Dockerfile -t kesher/api:t0021 .
3. docker run --rm kesher/api:t0021 id -un
4. docker run --rm kesher/api:t0021 node --experimental-strip-types --disable-warning=ExperimentalWarning src/index.ts
5. docker run --rm kesher/api:t0021 sh -c "test -L /app/apps/api/node_modules/@kesher/domain && readlink -f /app/apps/api/node_modules/@kesher/domain && test ! -e /app/apps/api/node_modules/@electric-sql/pglite-socket && echo dev-deps-excluded"
6. docker image rm kesher/api:t0021
Expected: step 2 finishes with the image tagged kesher/api:t0021. Step 3 prints `node` (the container does not run as root). Step 4 exits with code 1 and prints one JSON line with "event":"boot_failed","error":"ConfigError" naming the missing keys (DATABASE_URL, TOKEN_SIGNING_JWK, PII_DATA_KEY and the rest): no stack trace and no value. Step 5 prints `/app/packages/domain` then `dev-deps-excluded`.
Report back: the last 20 lines of step 2, and the full output of steps 3, 4 and 5.
