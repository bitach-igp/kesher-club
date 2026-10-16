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

## Commands

```
pnpm --filter @kesher/worker typecheck
pnpm --filter @kesher/worker test
```
