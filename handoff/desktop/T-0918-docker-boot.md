Task: T-0918 · Branch: claude/practical-babbage-80xevv · Needs: docker
Why: T-0917's run found that a container with no settings answered 500 and logged nothing. The console now checks its config when the server starts and exits 1 with one `boot_failed` JSON line, as the API does. The cloud session confirmed this on the standalone output under plain Node, but not in Docker. The values below are throwaway placeholders; nothing here is a real secret or a real member.
Steps (from repo root, PowerShell on Windows unless stated):
1. git rev-parse --short HEAD
2. docker build -f apps/admin/Dockerfile -t kesher/admin:t0918 .
3. docker run --name kesher-admin-noenv kesher/admin:t0918
4. docker inspect kesher-admin-noenv --format "{{.State.ExitCode}}"
5. docker rm -f kesher-admin-noenv
6. docker run --name kesher-admin-bad -e ADMIN_ENVIRONMENT=preview -e ADMIN_BASE_URL=https://admin.example -e ADMIN_VPN_CIDRS=vpn-range-typo -e ADMIN_OIDC_ISSUER=https://idp.example -e ADMIN_OIDC_AUDIENCE=kesher -e ADMIN_OIDC_CLIENT_ID=kesher -e ADMIN_OIDC_CLIENT_SECRET=do-not-print-me -e ADMIN_OIDC_JWKS_URL=https://idp.example/jwks -e ADMIN_DATA=memory kesher/admin:t0918
7. docker rm -f kesher-admin-bad
8. docker run -d --name kesher-admin -p 3933:3000 -e ADMIN_ENVIRONMENT=preview -e ADMIN_BASE_URL=https://admin.example -e ADMIN_VPN_CIDRS=192.168.0.0/16 -e ADMIN_OIDC_ISSUER=https://idp.example -e ADMIN_OIDC_AUDIENCE=kesher -e ADMIN_OIDC_CLIENT_ID=kesher -e ADMIN_OIDC_CLIENT_SECRET=throwaway -e ADMIN_OIDC_JWKS_URL=https://idp.example/jwks -e ADMIN_DATA=memory kesher/admin:t0918
9. Start-Sleep -Seconds 5
10. curl.exe -s http://localhost:3933/healthz
11. docker rm -f kesher-admin
12. docker image rm kesher/admin:t0918
Expected: step 2 finishes with the image tagged kesher/admin:t0918. Step 3 prints Next's banner and then one JSON line with `"event":"boot_failed","error":"ConfigError"` naming the missing ADMIN_* keys, then returns. Step 4 prints `1`. Step 6 returns the same way, with a boot_failed line saying `ADMIN_VPN_CIDRS: entry 1 is not a CIDR`; neither `vpn-range-typo` nor `do-not-print-me` appears anywhere in its output. Step 10 prints `{"status":"ok"}`.
Report back: the full output of steps 3, 4, 6 and 10, and the last 5 lines of step 2.
