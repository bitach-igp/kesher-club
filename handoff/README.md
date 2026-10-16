# Desktop handoff

Cloud sessions can't reach Zvi's Windows PC: Docker Desktop, Expo on a real phone, browser sign-ins,
local secrets, files under `C:\dev\bitach\IGP`. When a step needs the PC, don't block on it.

## Asking (cloud session)
Commit `handoff/desktop/<T-NNNN>-<slug>.md` on your branch, push, mention it in the PR description,
and carry on with the rest of the card.

```
Task: T-NNNN · Branch: <branch> · Needs: docker | device | browser | secrets | other
Why: one line on why the cloud can't do it
Steps (from repo root, PowerShell on Windows unless stated):
1. <exact command>
2. <exact command>
Expected: <what success looks like>
Report back: <logs / output / screenshot to commit>
```

Rules for requests: exact commands only, no "set up X"; no step may ask for a password, a payment, a
production deploy or deleting anything outside the repo.

## Answering (hourly desktop checker)
The scheduled "Kesher desktop checker" runs the steps on the PC in a separate worktree
(`C:\dev\bitach\IGP\05-code\_runner\kesher-club`), then on the same branch moves the request to
`handoff/done/` with a `## Result` section (outcome, trimmed output, date) and pushes. If it can't do a
step safely it writes `## Blocked` with the reason instead, and tells Zvi.
