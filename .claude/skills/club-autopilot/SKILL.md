---
name: club-autopilot
description: Run the Kesher Club card pipeline end to end - scout, code, check, PR, independent review, squash-merge - one card per commit and PR, with the merge gate, model split, real-Postgres handoff and revert rule. Use when asked to work cards autonomously, "own the pipeline", or merge ready PRs.
---

# Club autopilot: build, review, merge

Read `AGENTS.md` and `CLAUDE.md` first. This skill is the loop, not the rules.

## Identity and tools
- Commit with `git -c user.name="Zvi Landsman" -c user.email="spl13@columbia.edu" commit`.
- Message: `feat(scope): what [T-NNNN]`. One card per commit and per PR.
- PRs and merges use the GitHub REST API through `gh api` (never GraphQL). Squash merge:
  `gh api -X PUT repos/bitach-igp/kesher-club/pulls/N/merge -f merge_method=squash`.
  Bring a PR up to date: `gh api -X PUT repos/bitach-igp/kesher-club/pulls/N/update-branch`.
- Check runs: `gh api repos/bitach-igp/kesher-club/commits/<sha>/check-runs`.
- Never force-push to main, bypass protection, or merge a stacked PR before its base.

## Per card
1. **Scout** (Haiku subagent, read-only): card, review finding, cited code. Report files to change, prior art,
   exact types/APIs, risks, at most 60 lines with paths. Verify its claims before relying on them.
2. **Code** (you): test first, then the fix. Touch only the card's files (shared plumbing: `apps/api/src/app.ts`,
   `apps/api/src/routes.ts`, `HEADER_OPS` in `packages/sdk/src/client.ts`; say so in the PR). Run
   `pnpm typecheck`, `pnpm lint`, `pnpm test`, `pnpm trace` (plus `pnpm db:lint` for a migration) before pushing.
3. **Review**: a fresh subagent given the card and the PR diff only, never your reasoning. Opus for money paths
   (as of 2026-11-04: T-0539..T-0546, T-0312, T-0658, T-1018, T-0659, T-0660; any card that moves money or touches auth), Sonnet otherwise. It reports: does it do what the
   card asks, bugs and edge cases, weak tests, changes outside the card; then `APPROVE` or `CHANGES NEEDED`.
   At most two fix rounds; then label the PR `needs-human`, leave it open, move on.
4. **Parallelism**: scout the next card while CI runs on the current one; code one card at a time, each on its
   own branch.

## Merge gate (all must hold)
- Every required check green (re-run once if flaky; never merge on red or pending).
- Reviewer said APPROVE on the final diff (re-review after any fix commit).
- Any real-Postgres handoff for the card has a `## Result` with a passing outcome in `handoff/done/` on the branch (a `## Blocked` section is not a pass).
- Up to date with main (update-branch, then wait for CI again).
- No open owner decision on the card.
If a merge is refused, do not work around it: label `ready-to-merge` and leave the PR open (apply that label only when the gate above is otherwise fully met; never on a `needs-human` PR, and never mark such a PR done, so the checker skips it); the hourly desktop
checker merges ready PRs whose card is done and CI is green (see AGENTS.md, "Steps that need the desktop").

## Real Postgres
Migrations applying and concurrency races cannot run in the cloud. Commit `handoff/desktop/T-NNNN-slug.md`
per `handoff/README.md`, push, wait for the checker's PASS on the branch before merging.

## Before and after merging
- Before merging, append one line to `docs/ops/autopilot-log.md` in the card's own PR (a one-line append;
  if it conflicts after update-branch, keep both lines): date, card, PR, reviewer verdict, CI as of the final push.
  That file is a permitted shared file (a fourth exception to the card's-files-only rule).
- After merging, report one line: card, PR, reviewer verdict, CI.
- If a merge turns main red: open a revert PR immediately (same gate except the review: the owner's rule, since a
  revert restores code that was already reviewed), then reopen the card.
- Commits also carry the trailers the session gives (Co-Authored-By, Claude-Session).

## Cost control
A session's credits are shared across a five-hour window; spend them deliberately.
- Scouts and mechanical work (renames, doc edits, log rows, CI reading) go to Haiku. Reviews default to Sonnet. On 2026-11-04 the user asked to throttle credit use, which relaxes the Opus-for-money-paths rule above until they say otherwise: money-path cards are reviewed by Sonnet, and Opus is used only when the user asks for it.
- Give a reviewer the card and the diff only, and ask for a report under 300 words. After a fix commit the reviewer that approves reads the full final diff; the delta since the last round only tells it where to look first.
- Run the whole check set (`pnpm typecheck`, `lint`, `test`, `trace`) before pushing, including other packages' tests when a shared behaviour changed; a CI-only failure costs a round trip.
- Do not poll. Subscribe to the PR and end the turn; the CI event wakes the session. Events for an older head are not the current head's result.
- One card at a time. When the user asks to throttle, finish the card in flight and stop starting new ones until told.
