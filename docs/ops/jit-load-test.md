# JIT load test: results

The test, its variables and its safety rules are in [tools/loadtest/README.md](../../tools/loadtest/README.md) (T-0055).
Target: p99 under 300 ms and errors under 1 % at 50 req/s, twice the pilot peak (REQ-CRD-003, RUN-02), against staging with
`PROVIDER_CARD=sim`. The in-process unit test (`apps/api/src/cards/jit.bench.test.ts`, 200 req/s against PGlite) is not this result.

## First result: pending, to be recorded by a human run

No result has been recorded. Staging is not deployed yet (deploy readiness review, `deploy-readiness.md`), and the session
that built the test had neither k6 nor network access. Nothing below is a measurement.

To record it, once staging is up and seeded (README, "Seeding staging"):

```
JIT_URL=https://<staging jit host>/v1/jit/card-authorizations JIT_SIGNATURE=sim \
  k6 run --summary-export loadtest-summary.json tools/loadtest/jit.js
```

Then fill the table from the k6 summary and from CloudWatch (`Kesher / jit.decision_ms` p99 and `jit.error` Average over the same window), and commit it.

| Date | Commit | Rate | Duration | k6 p99 (ms) | k6 failed rate | `jit.decision_ms` p99 (ms) | `jit.error` avg | Result | Run by |
|---|---|---|---|---|---|---|---|---|---|
| pending | pending | 50 req/s | 5m | pending | pending | pending | pending | pending | pending |
