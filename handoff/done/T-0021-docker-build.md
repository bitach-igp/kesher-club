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

## Result
PASS, 2026-10-19 13:06 (Asia/Jerusalem), desktop checker on Zvi's PC (Docker 29.8.2), runner worktree at a0565cf
(claude/practical-babbage-80xevv; same Dockerfile and sources as 8f483d6).

Step 1: `a0565cf`

Step 2 (exit 0), last lines:
```
#9 1.950 Done in 1.6s using pnpm v10.28.0
#9 2.254 Removed all cached metadata files
#9 DONE 3.9s
#10 [6/6] WORKDIR /app/apps/api
#10 DONE 0.1s
#11 exporting to image
#11 exporting layers 0.9s done
#11 naming to docker.io/kesher/api:t0021 done
#11 unpacking to docker.io/kesher/api:t0021 3.2s done
#11 DONE 4.2s
```

Step 3 (exit 0):
```
node
```

Step 4 (exit 1, one line, no stack trace, no values):
```
{"at":"2026-10-19T10:05:56.028Z","service":"api","event":"boot_failed","error":"ConfigError","message":"Missing configuration: NODE_ENV, DATABASE_URL, TEMPORAL_ADDRESS, PROVIDER_MODE_DEFAULT, TOKEN_SIGNING_JWK, TOKEN_SIGNING_KID, TOKEN_ISSUER, MARKET, STAFF_JWKS, PII_DATA_KEY, PII_INDEX_KEY, PORT"}
```

Step 5 (exit 0):
```
/app/packages/domain
dev-deps-excluded
```

Step 6 (exit 0): `Untagged: kesher/api:t0021`, image deleted.

All four expectations met.
