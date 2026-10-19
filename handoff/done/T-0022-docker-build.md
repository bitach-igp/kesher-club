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

## Result
PASS, 2026-10-19 14:06 (Asia/Jerusalem), desktop checker on Zvi's PC (Docker 29.8.2), runner worktree at a7f0d13
(claude/practical-babbage-80xevv; carries 5803a8c T-0022 from main plus T-0023).

Step 1: `a7f0d13`

Step 2 (exit 0, layers were in the local build cache), last lines:
```
#9 [5/6] RUN pnpm install --frozen-lockfile --prod --filter @kesher/worker...  && pnpm store prune  && chown -R node:node /app
#9 CACHED
#10 [6/6] WORKDIR /app/apps/worker
#10 CACHED
#11 exporting to image
#11 exporting layers done
#11 naming to docker.io/kesher/worker:t0022 done
#11 unpacking to docker.io/kesher/worker:t0022 0.0s done
#11 DONE 0.2s
```

Step 3 (exit 0):
```
node
```

Step 4 (exit 1, one line, no stack trace, no values):
```
{"at":"2026-10-19T11:06:28.014Z","service":"worker","event":"boot_failed","error":"ConfigError","message":"Missing configuration: APP_ENV, DATABASE_URL, TEMPORAL_ADDRESS, PROVIDER_MODE_DEFAULT, JWT_SIGNING_KEY, JWT_SIGNING_KID, TOKEN_ISSUER, MARKET, STAFF_JWKS, PII_DATA_KEY, PII_INDEX_KEY"}
```

Step 5 (exit 0):
```
/app/apps/api
dev-deps-excluded
```

Step 6 (exit 0): `Untagged: kesher/worker:t0022`, image deleted.

All four expectations met.
