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
