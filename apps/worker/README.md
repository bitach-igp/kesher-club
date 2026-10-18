# apps/worker

Background work: the ledger balance proof, reconciliation, dunning, allowance runs, catalogue
sync and eSIM usage polling. Each workflow is a deterministic function over an activities
interface, so it runs under Temporal unchanged once ADR-002 lands and under a plain scheduler
until then; every money movement's workflow ID is its idempotency key.

| Module | Card | What it does |
| --- | --- | --- |
| `ledger/balance-proof` | T-0203 | Nightly proof that every account balance equals its postings and the system sums to zero; breaks open `ops.case` rows |
| `recon/recon` | T-0204 | Partner statement vs ledger; `ops.recon_break` per mismatch, dedupe by (provider, external id, run date) |
| `billing/dunning` | T-0304 | Past-due memberships: retries, grace, pause |
| `allowance/` | T-0605 | Institution allowance runs with preview, two-person approval above the threshold, per-member failures |
| `catalogue/sync` | T-0702 | Pulls vendor packages into the catalogue with the markup policy |
| `esim/usage` | T-0710 | Usage polling and low-data / expiry notifications |
| `monitoring/` | T-0909 | Transaction monitoring rules v1 over the last day of `ops.transfer`; one `ops.case` per finding for the compliance console, behind `monitoring.rules` |

## Commands

```
pnpm --filter @kesher/worker typecheck
pnpm --filter @kesher/worker test
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
