Task: T-0047 · Branch: card/T-0047 · Needs: docker
Why: apps/console/Dockerfile is new and the cloud session has no Docker daemon, so the image build and container boots go on the PC. The values below are throwaway placeholders; nothing here is a real secret.
Steps (from repo root, PowerShell on Windows unless stated):
1. git rev-parse --short HEAD
2. docker build -f apps/console/Dockerfile -t kesher/console:t0047 .
3. docker run --rm kesher/console:t0047 id -un
4. docker run -d --name kesher-console-noenv kesher/console:t0047
5. Start-Sleep -Seconds 5
6. docker ps -a --filter name=kesher-console-noenv --format "{{.Status}}"
7. docker logs kesher-console-noenv
8. docker rm -f kesher-console-noenv
9. docker run -d --name kesher-console -p 3941:3000 -e CONSOLE_ENVIRONMENT=preview -e CONSOLE_API_URL=https://api.example/v1 kesher/console:t0047
10. Start-Sleep -Seconds 5
11. curl.exe -s -w " %{http_code}" http://localhost:3941/healthz
12. curl.exe -s -o NUL -w "%{http_code}" http://localhost:3941/roster
13. docker image inspect kesher/console:t0047 --format "{{.Size}}"
14. docker rm -f kesher-console
15. docker image rm kesher/console:t0047
Expected: step 2 tags the image. Step 3 prints `node`. Step 6 shows the container exited (Exited (1)). Step 7 shows one JSON boot_failed line with service console naming CONSOLE_ENVIRONMENT and CONSOLE_API_URL and no values. Step 11 prints `{"status":"ok"} 200`. Step 12 prints `303` (signed out goes to /sign-in). Step 13 prints the image size in bytes.
Report back: the last 20 lines of step 2, and the full output of steps 3, 6, 7, 11, 12 and 13.

## Result
Outcome: PASS after one fix. Run 2026-11-08 04:05–04:10 Asia/Jerusalem on Zvi's PC (Docker 29.9.2), runner worktree.

- First run at `02b9901`: step 2 FAILED. `next build` in the build stage: `Error: Module not found: Can't resolve '@kesher/tokens/css'` (apps/console/app/layout.tsx:5). Cause: `.dockerignore` excludes `**/dist`, and nothing builds `@kesher/tokens` in the image, so `dist/css/tokens.css` is missing. (The admin Dockerfile has the same gap since layout.tsx started importing `@kesher/tokens/css`; not touched here, outside this card.)
- Fix: `&& pnpm --filter @kesher/tokens build` before the console build in `apps/console/Dockerfile` (committed on this branch). Re-run of all steps with that line:

1. `02b9901` (+ the Dockerfile line, now committed)
2. exit 0; last lines: `#11 [stage-1 4/4] COPY --from=build ... /app/apps/console/.next/static ./apps/console/.next/static` … `#12 naming to docker.io/kesher/console:t0047 done` … `#12 DONE 5.3s`
3. `node`
6. `Exited (1) 4 seconds ago`
7. Next's banner, then:
   `{"at":"2026-11-08T02:09:22.499Z","service":"console","event":"boot_failed","error":"ConfigError","message":"Missing configuration: CONSOLE_ENVIRONMENT, CONSOLE_API_URL"}`
11. `{"status":"ok"} 200`
12. `303`
13. `412425672` (~412 MB)
14–15. Containers and image removed.
