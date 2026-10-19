# apps/worker

Background work: the ledger balance proof, reconciliation, dunning, catalogue
sync and eSIM usage polling. Each workflow is a deterministic function over an activities
interface, so it runs under Temporal unchanged once ADR-002 lands and under a plain scheduler
until then; every money movement's workflow ID is its idempotency key.

| Module | Card | What it does |
| --- | --- | --- |
| `ledger/balance-proof` | T-0203 | Nightly proof that every account balance equals its postings and the system sums to zero; breaks open `ops.case` rows |
| `recon/recon` | T-0204 | Partner statement vs ledger; `ops.recon_break` per mismatch, dedupe by (provider, external id, run date) |
| `billing/dunning` | T-0304 | Past-due memberships: retries, grace, pause |
| `catalogue/sync` | T-0702 | Pulls vendor packages into the catalogue with the markup policy |
| `esim/usage` | T-0710 | Usage polling and low-data / expiry notifications |
| `fx/refresh-rates` | T-0513 | Every 5 minutes, publishes the FX port's mid as the club rate for 15 minutes unless a manual rate is active (ADR-007) |
| `monitoring/` | T-0909 | Transaction monitoring rules v1 over the last day of `ops.transfer`; one `ops.case` per finding for the compliance console, behind `monitoring.rules` |

## Running it (T-0022)

`src/index.ts` boots the worker from the environment (the same keys as the API, without `PORT`; see
`apps/api/src/config.ts`), builds the API's services through `createApp` and runs every job in
`src/jobs.ts` on the plain scheduler (`src/scheduler.ts`, ADR-002) until SIGTERM. Each job runs at boot,
then once per cycle timed from the end of the last run, so a job never overlaps itself. A failed run
logs one line (job, error class and code; never a message or a payload) and runs again next cycle.

Every job has a scope (T-0028). A `market` job (load, payout and hold sweeps, auto-reload, token
events, webhook replay, eSIM usage, catalogue sync) reads only rows that carry its worker's market and
calls that market's providers; each market's worker runs its own. A `club` job (club rate, monitoring,
balance proof, payment request and intent expiry, P2P send completion, stale conversions) is not split
by market, so one lock spans the club. A run holds a Postgres advisory lock on `market:job` or
`club:job` (`src/lock.ts`), on a one-connection pool of its own, and a task that finds the lock held skips that run.
SIGTERM schedules nothing more and lets running jobs finish (up to 20 s; ECS kills at 30 s). Jobs keep
their own flag checks.

| Job | Module | Cycle |
| --- | --- | --- |
| `card-token-events` | `cards/token-events` | 30 s |
| `load-sweep` | `wallet/load-workflow` | 1 min |
| `send-sweep` | `p2p/send-workflow` | 1 min |
| `payout-sweep` | `payouts/payout-workflow` | 1 min |
| `p2p-release-holds` | `p2p/release-holds` | 1 min |
| `fx-void-stale` | `fx/void-stale` | 1 min |
| `webhook-replay` | `apps/api` `webhooks/handler` (RUN-05) | 1 min |
| `fx-refresh-rates` | `fx/refresh-rates` | 5 min |
| `ach-release-holds` | `wallet/release-holds` | 5 min |
| `p2p-expire-requests` | `p2p/expire-requests` | 15 min |
| `auto-reload` | `wallet/auto-reload-job` | 15 min |
| `agent-expire-intents` | `agent/expire-intents` | 15 min |
| `monitoring` | `monitoring/job` | 1 h |
| `esim-usage` | `esim/usage` | 1 h |

Nightly jobs (T-0023) run once per Israel calendar day at their wall-clock time. Each ticks every minute;
once Israel time passes its slot and `ops.job_run` has no row for today's Israel date, it runs and then
records the row. A worker that boots late runs it once, and a restart the same day does not run it
again. A failed run records nothing, so the next tick retries it. DST needs no special case: on the night
the clocks jump past the slot, the first tick after the jump runs it. Idle ticks log nothing.

| Job | Module | Israel time |
| --- | --- | --- |
| `balance-proof` | `ledger/balance-proof` | 02:30 |
| `catalogue-sync` | `catalogue/sync`, asking each market's vendors for what `config/catalogue.json` lists; recorded per market | 03:00 |

Reconciliation joins at 04:00 Israel time with the processor adapter, which brings its statement
source, ahead of REQ-LED-004's 06:00 deadline.

Not on the scheduler: the card issue workflow (started by a KYC approval). Allowance runs moved to
the API (`apps/api/src/institutions/allowance/`, T-0607), where the institution's finance staff start
them. Dunning waits on billing events. `src/jobs.test.ts` fails on a new job module that is neither in the table nor
in `JOB_EXCLUSIONS` with its reason.

## Commands

```
pnpm --filter @kesher/worker typecheck
pnpm --filter @kesher/worker test
pnpm --filter @kesher/worker start        # needs the environment above
docker build -f apps/worker/Dockerfile .  # from the repository root
```

## Monitoring rules v1 (T-0909)

`monitoring/rules.ts` is pure: movements in, findings out. `monitoring/job.ts` reads the last 24 hours
of `p2p` and `payout` transfers (every attempt, whatever became of it), runs the rules and opens one
`ops.case` per finding. Fan-in and fan-out are listed by the console as `velocity` cases with the rule
in the payload. A case payload is ids, counts, amounts and times; a member's note never reaches it.

| Rule | Window | Fires when | Case kind, severity |
| --- | --- | --- | --- |
| structuring | 1 hour | 10 or more P2P sends, each from 80 % of the hold line (₪500 / $150) up to, not including, the line | `structuring`, high |
| velocity | 24 hours | 25 or more outgoing movements, or ₪20,000 / $6,000 out | `velocity`, medium (high when both) |
| fan-in | 24 hours | sends received from 10 or more different members | `velocity` (`rule: fan_in`), medium |
| fan-out | 24 hours | sends made to 10 or more different members | `velocity` (`rule: fan_out`), medium |

Dedupe is twofold. A finding's key is anchored on the first transfer of the pattern, so a re-run over
the same data opens nothing twice. An undecided case (no disposition, or `in_review`) for the same
party and rule suppresses a new one until compliance records `cleared` or `escalated` in the console;
the next pattern after that opens a fresh case. Thresholds live in `THRESHOLDS`; change them there.
