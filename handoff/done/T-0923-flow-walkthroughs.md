Task: T-0923 · Branch: claude/practical-babbage-80xevv · Needs: docker-free; Node 22, pnpm, gh (signed in to github.com with write access to bitach-igp/kesher-club)
Why: The bank-review package (docs/bank-review/) links one product walkthrough per money flow, REC-01 to REC-18. They are recorded by the browser itself from the running product on the simulators (apps/demo/src/record/, T-0920 to T-0923, T-0927), and every recording asserts that the amounts on screen equal the worked examples in docs/bank-review/money-flows.md, in minor units, so a run that passes cannot show a wrong number. The videos never enter git: eighteen files of a few MB each would stay in the repository's history for ever. This asks the PC to record all eighteen once and publish them as the assets of one GitHub Release, `bank-review-recordings-2026-10-30`, at the commit it recorded. The cloud session recorded all eighteen locally and they passed; it cannot publish a release. Nothing here is a real person, account or amount. Nothing is deleted.
Steps (from repo root, PowerShell on Windows, on the branch at the commit that filed this request):
1. pnpm install --frozen-lockfile
2. pnpm --filter @kesher/demo exec playwright install chromium
3. New-Item -ItemType Directory -Force handoff/done/recordings | Out-Null
4. pnpm --filter @kesher/demo record 2>&1 | Tee-Object -FilePath handoff/done/recordings/T-0923-record-run.log
5. (Get-ChildItem apps/demo/out/REC-*.webm).Name
6. gh release create bank-review-recordings-2026-10-30 (Get-ChildItem apps/demo/out/REC-*.webm).FullName --repo bitach-igp/kesher-club --target (git rev-parse HEAD) --title "Bank-review walkthroughs, 30 October 2026" --notes "REC-01 to REC-18: one product walkthrough per money flow in docs/bank-review/money-flows.md, recorded from the running product on the simulators at this commit. Each recording asserts that its amounts equal the flow's worked example. Fictional personas and amounts only."
7. gh release view bank-review-recordings-2026-10-30 --repo bitach-igp/kesher-club --json assets --jq ".assets[].name"
Expected: the run starts its own servers on ports 3000, 3100, 3200, 4010, 4099 and 8081, which must be free; the first Expo and Next.js compiles take a few minutes. Step 4 ends with `18 passed` and no failures. Step 5 lists exactly these eighteen files: REC-01-load-by-card.webm, REC-02-ach-hold-release.webm, REC-03-load-other-purse.webm, REC-04-auto-reload.webm, REC-05-p2p-send.webm, REC-06-p2p-new-pair-hold.webm, REC-07-p2p-cross-currency.webm, REC-08-requests-splits.webm, REC-09-assistant-send.webm, REC-10-fx-conversion.webm, REC-11-club-rates.webm, REC-12-card-authorisation.webm, REC-13-institution-withdrawal.webm, REC-14-allowance-run.webm, REC-15-collections.webm, REC-16-addon-purchase.webm, REC-17-closure-refunds.webm, REC-18-ledger-reversals.webm. Step 6 prints the release URL; step 7 lists the same eighteen names.
The amounts each recording asserts (minor units; the run fails if any differs): REC-01 a $100.00 card load lands 10,000 cents. REC-02 a $100.00 ACH load holds 10,000 cents, then releases them after 3 business days. REC-10 $100.00 at 3.71 is ₪371.00 gross, 278 agorot of markup, ₪368.22 received. REC-13 a ₪20,000.00 deposit, a ₪6,000.00 withdrawal (cools off 24 hours, second approver), ₪14,000.00 left. REC-14 three students at ₪2,000.00, 600,000 agorot in all, each purse +200,000. REC-15 ₪1,200.00 tuition billed to three students, Noa pays 120,000 agorot with a receipt number. REC-16 an eSIM at the A05 rule's price ($9.50 cost becomes $11.99). REC-17 Ruth's $30.00 (3,000 cents) refunded to her card and every purse at zero. REC-18 a $50.00 ACH load returned during its hold and reversed, then the balance proof finds 0 breaks, 0 unbalanced journals and system totals of 0.
Report back: the last 30 lines of handoff/done/recordings/T-0923-record-run.log, the output of steps 5 to 7, and the release URL.

## Result
Partly done, 2026-10-30 13:24 Asia/Jerusalem (desktop checker). Steps 1 to 5 PASS; steps 6 and 7 Blocked (below).
Run on Zvi's PC in the runner worktree at 476db73 (Windows, Node v24.19.0, pnpm 10.28.0 via corepack).

- Step 1: `pnpm install --frozen-lockfile` done in 52.6s (esbuild build script ignored, as before).
- Step 2: Playwright chromium installed (it also fetched winldd).
- Steps 3-4: the first attempt failed before any test ran: Playwright's webServer spawns `pnpm`, which is not on
  the PC's PATH (pnpm exists only through corepack). The checker reran with a `pnpm.cmd` shim
  (`@corepack pnpm %*`) placed first on PATH for that process only, nothing else changed. Result: `18 passed (7.4m)`,
  no failures. Two Next.js hydration warnings during REC-13/14 (body `data-leaving="1"`), not failures.
  Trimmed log: `handoff/done/recordings/T-0923-record-run.log`.
- Step 5: exactly the eighteen expected files in apps/demo/out (left there on the PC, not in git):
  REC-01-load-by-card.webm 3.2MB, REC-02-ach-hold-release.webm 1.3MB, REC-03-load-other-purse.webm 1.0MB,
  REC-04-auto-reload.webm 1.4MB, REC-05-p2p-send.webm 1.4MB, REC-06-p2p-new-pair-hold.webm 1.8MB,
  REC-07-p2p-cross-currency.webm 1.5MB, REC-08-requests-splits.webm 1.1MB, REC-09-assistant-send.webm 1.0MB,
  REC-10-fx-conversion.webm 1.0MB, REC-11-club-rates.webm 3.0MB, REC-12-card-authorisation.webm 1.4MB,
  REC-13-institution-withdrawal.webm 2.7MB, REC-14-allowance-run.webm 2.9MB, REC-15-collections.webm 1.6MB,
  REC-16-addon-purchase.webm 1.0MB, REC-17-closure-refunds.webm 1.0MB, REC-18-ledger-reversals.webm 1.3MB.

## Blocked
Steps 6 and 7 (`gh release create` / `gh release view`) were not run:
- `gh` is not installed on the PC.
- Creating a release also creates a tag on the repository, which is outside what the checker is allowed to do
  (it pushes only to feature branches). Zvi publishes it himself, or approves the checker doing it.
No release exists yet, so the bank-review links still answer 404. The eighteen videos are on the PC at
`C:\dev\bitach\IGP\05-code\_runner\kesher-club\apps\demo\out\` (recorded at 476db73) and can be uploaded from there;
the next checker run recording again would overwrite them.
