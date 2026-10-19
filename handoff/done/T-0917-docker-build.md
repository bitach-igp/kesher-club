Task: T-0917 · Branch: claude/practical-babbage-80xevv · Needs: docker
Why: apps/admin/Dockerfile is new and the cloud session has no Docker daemon, so the image build and container boots go on the PC. The cloud session already ran the same standalone output outside the repository under plain Node. /healthz answered 200 to a caller with no VPN header. Sign-in rendered the runtime environment's banner. Outside IPs got 403 and a VPN caller without a session got 303. The values below are throwaway placeholders; nothing here is a real secret or a real member.
Steps (from repo root, PowerShell on Windows unless stated):
1. git rev-parse --short HEAD
2. docker build -f apps/admin/Dockerfile -t kesher/admin:t0917 .
3. docker run --rm kesher/admin:t0917 id -un
4. docker run -d --name kesher-admin-noenv -p 3931:3000 kesher/admin:t0917
5. Start-Sleep -Seconds 5
6. curl.exe -s -o NUL -w "%{http_code}" http://localhost:3931/healthz
7. docker logs kesher-admin-noenv
8. docker rm -f kesher-admin-noenv
9. docker run -d --name kesher-admin -p 3932:3000 -e ADMIN_ENVIRONMENT=preview -e ADMIN_BASE_URL=https://admin.example -e ADMIN_VPN_CIDRS=192.168.0.0/16 -e ADMIN_OIDC_ISSUER=https://idp.example -e ADMIN_OIDC_AUDIENCE=kesher -e ADMIN_OIDC_CLIENT_ID=kesher -e ADMIN_OIDC_CLIENT_SECRET=throwaway -e ADMIN_OIDC_JWKS_URL=https://idp.example/jwks -e ADMIN_DATA=memory kesher/admin:t0917
10. Start-Sleep -Seconds 5
11. curl.exe -s http://localhost:3932/healthz
12. curl.exe -s -o NUL -w "%{http_code}" -H "x-forwarded-for: 10.1.1.1" http://localhost:3932/customers
13. curl.exe -s -o NUL -w "%{http_code}" -H "x-forwarded-for: 192.168.1.5" http://localhost:3932/customers
14. docker image inspect kesher/admin:t0917 --format "{{.Size}}"
15. docker rm -f kesher-admin
16. docker image rm kesher/admin:t0917
Expected: step 2 finishes with the image tagged kesher/admin:t0917. Step 3 prints `node` (the container does not run as root). Step 6 prints `500`, because a container with no settings never reports healthy. Step 7 shows a ConfigError naming the missing ADMIN_* keys and no values. Step 11 prints `{"status":"ok"}`. Step 12 prints `403` and step 13 prints `303`. Step 14 prints the image size in bytes; expect a few hundred MB.
Report back: the last 20 lines of step 2, and the full output of steps 3, 6, 7, 11, 12, 13 and 14.

## Result
Outcome: PARTIAL. Build, user, configured boot, VPN gate and size all as expected; the unconfigured container answers 500 as listed but logs no ConfigError (step 7 differs). Run 2026-10-19 23:15 Asia/Jerusalem on Zvi's PC (Docker 29.8.2), runner worktree at ef930fc.

1. `ef930fc`
2. exit 0; last lines: `#11 [stage-1 4/4] COPY --from=build --chown=node:node /app/apps/admin/.next/static ./apps/admin/.next/static` … `#12 naming to docker.io/kesher/admin:t0917` … `#12 DONE 5.3s`
3. `node`
6. `500`
7. Only Next's banner, no ConfigError line, even after the step 6 request:
   ```
   ▲ Next.js 16.4.2
   - Local:         http://localhost:3000
   - Network:       http://0.0.0.0:3000
   ✓ Ready in 0ms
   ✓ Running next.config took 1.2ms
   ```
   Re-run for diagnosis (same commit): `curl -i /healthz` returns `HTTP/1.1 500 Internal Server Error` with the plain-text body `Internal Server Error`, not the route's `{"status":"misconfigured"}` JSON. `app/healthz/route.ts` catches config errors and answers 503, so the 500 comes from something that throws before the route (likely the proxy/middleware or a module-level config load) and the error is not logged. Expected output (500 + ConfigError naming ADMIN_* keys) and the route (503) also disagree with each other.
11. `{"status":"ok"}`
12. `403`
13. `303`
14. `411170454` (~411 MB)
15–16. Container and image removed; nothing left behind.
