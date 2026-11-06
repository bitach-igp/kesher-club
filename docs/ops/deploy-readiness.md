# Deploy readiness: CTO review, 2026-11-05

Scope: every doc, ADR, runbook and Terraform root in the repo, read against the merged cards (T-0001 to
T-0660, T-1018 and the fix cards through T-0555) and the code they produced. Question asked: what stands
between `main` and a running staging and a pilot production? Cards T-0040 to T-0062 carry every gap below.
Nothing in this review changes code.

## Verdict

The product is built; the platform around it is not. The application code, the ledger, the simulators and the
Terraform skeleton are in good shape (171 operations equal 171 routes, insert-only ledger, 18 recorded
walkthroughs, three accounts, WAF, CMKs, 35-day PITR, immutable ECR). But **no environment can be deployed
today**, for four independent reasons, any one of which stops a launch:

1. **Neither staging nor prod can boot.** `envs/staging` passes `PROVIDER_MODE_DEFAULT=sandbox` and `envs/prod`
   passes `live`; `apps/api/src/config.ts:94` refuses anything but `sim`, and
   `packages/domain/src/config.ts:74` refuses `sim` in prod. `infra-contract.test.ts` checks that the KEYS
   exist, not the values, so CI is green. (T-0025 accepted this "until ADR-006"; the cost is that nothing
   deployed has ever started.)
2. **Nothing deploys.** `release.yml` stops at printing a `terraform apply` line; T-0030 called deploy "a card
   of its own" and no card was written.
3. **Nothing prepares the database.** The RDS is in isolated subnets, `db/README.md` says prod applies "from
   CI with the club_migrator secret", but no task, image or workflow does it, the `club_migrator` secret does
   not exist, and `roles.sql` has no executor. The least-privilege `club_jit` role is defined and never used
   (the JIT service runs as `club_app`).
4. **Nobody would know it broke.** The runbooks name ten paging alerts "defined in infra/terraform"; there is not
   one alarm, SNS topic or budget in `infra/`, the apps emit no metrics, and there is no structured logger.

## Findings, by severity

| # | Severity | Finding | Evidence | Card |
|---|---|---|---|---|
| 1 | Blocker | Config refuses what Terraform passes; the contract test checks keys only | `apps/api/src/config.ts:94`, `packages/domain/src/config.ts:74`, `envs/*/main.tf` | T-0040, T-0043 |
| 2 | Blocker | Prod forbids simulators, but the card, KYC, FX, payout and bank ports have no vendor (ADR-006), so a money-flags-off pilot cannot start | `packages/domain/src/config.ts:74` | T-0043 |
| 3 | Blocker | Built vendor adapters (Stripe, Twilio, Postmark, Expo, Airalo, Cover Genius, WorkOS, Apple, Google) are not selectable by config; only Crowded is (T-0659) | `apps/api/src/registry.ts` | T-0041, T-0042 |
| 4 | Blocker | No deploy workflow, no production approval gate, no smoke test, no recorded deployed tag | `.github/workflows/` has ci, preview, release | T-0050, T-0051 |
| 5 | Blocker | No migrate/roles task in the VPC; `club_migrator` and `club_jit` secrets absent; Atlas pulled as `:latest` | `db/migrate.mjs`, `envs/*/main.tf` | T-0044 |
| 6 | Blocker | The institution console is a Next server app deployed as a static bucket, with no Dockerfile and not in `release.yml` | `apps/console/proxy.ts`, `envs/*/main.tf` `module.console` | T-0047 |
| 7 | Blocker | The legal service has no HTTP surface: no way to show terms or record consent | `contracts/openapi.yaml` (no legal/consent operation) | T-0061, T-0062 |
| 8 | High | Zero alarms, topics, dashboards or budgets; the apps emit no metrics; no structured logger | `grep` over `infra/` and `apps/` | T-0052, T-0053, T-0054 |
| 9 | High | A fresh prod database has no system ledger accounts, no first admin, no legal or plan shell; the demo seed refuses prod | `apps/demo`, `docs/` | T-0046 |
| 10 | High | JIT runs as `club_app`, not `club_jit` | `module.jit` uses `common_secrets` | T-0045 |
| 11 | High | Secrets are empty containers with no generator, format or rotation guide | `infra/terraform/README.md` step 5 | T-0056 |
| 12 | High | The app cannot ship to a store: no bundle ids, associated domains, EAS profiles; passkeys, secure store and device facts are web shims | `apps/mobile/app.json`, `apps/mobile/README.md` | T-0058, T-0059 |
| 13 | High | `apps/web` is "Not started" but its CloudFront site is deployed; passkeys and universal links need `.well-known` files on the domain, the stores and Stripe need legal URLs | `apps/web/README.md` | T-0048 |
| 14 | Medium | Mail authentication (SPF, DKIM, DMARC) and CAA missing; the domain and account e-mails are `kesher.example` placeholders | `envs/shared/variables.tf`, `envs/prod/variables.tf:30` | T-0057 |
| 15 | Medium | No image scan, no SBOM, base images pinned by tag only | `release.yml`, Dockerfiles | T-0049 |
| 16 | Medium | The p99 under 300 ms target has no load test against a deployed JIT | no k6 or equivalent in repo | T-0055 |
| 17 | Medium | No acceptance record: restore drill (RUN-08), alarm test, VPN reach, a full empty-account deploy | `docs/runbooks/RUN-08-*.md` "Last tested" | T-0060 |
| 19 | High | There is no JIT process: `SERVICE_ROLE` is read by nothing, so the "jit" ECS service is a second full copy of the API, and `club_jit` holds grants on two `cards` tables only, so pointing the service at it would break card authorisation (found starting T-0045, 2026-11-06) | `grep SERVICE_ROLE` over the code; `db/migrations/ledger/0007_cards.sql:37-39` | T-0063, T-0064, then T-0045 |
| 18 | Low | `TEMPORAL_*` secrets and variables are required by the config and Terraform, but workers run on the plain scheduler and no Temporal client is a dependency | `packages/domain/src/config.ts`, `apps/worker/README.md` | Decision D1 |

## Decisions needed from the owner

- **D1. Temporal.** ADR-002 says Temporal Cloud "when the money flags turn on". Until then the pilot runs on the
  plain scheduler with advisory locks, which is fine for 2 workers per market. But the config still *requires*
  `TEMPORAL_ADDRESS` and `TEMPORAL_NAMESPACE` and Terraform requires two client-certificate secrets nobody can
  fill. Recommendation: make them optional until the first money flag is due, then add a card to host the
  workflows. (Not carded; one-line change once decided.)
- **D2. Console at the edge.** T-0047 puts the console on the public ALB behind the existing WAF. If you want
  CloudFront in front, say so; it must stay uncached.
- **D3. Pilot scope.** Everything below the line "money flags off" is deployable now. Card issuing, KYC, FX,
  payouts and the sponsor bank wait for ADR-006. Recommendation: deploy the pilot on *membership, eSIM,
  insurance, concierge, notifications and the institution console without money out*, and stage money flags per
  the release gates in `config/flags.json`.

## Build order

```
T-0040 → T-0041, T-0042, T-0043        provider binding; prod can boot (flags off)
T-0044 → T-0045, T-0046                database prepared; JIT least privilege; bootstrap
T-0061 → T-0062, T-0048                legal over HTTP; app screens; web site + .well-known
T-0047 → T-0049 → T-0050 → T-0051      console image; release hardening; deploy; smoke
T-0052 → T-0053 → T-0054 → T-0055      logger; metrics; alarms; load test
T-0056, T-0057                         secrets tool; mail/domain records
T-0058 → T-0059                        mobile release plumbing; native bindings
T-0060                                 staging acceptance (needs all of the above)
```

Cards that touch only `infra/` or only the app can run in parallel; T-0040 and T-0044 gate the rest.

## What only people can do (not carded)

| Item | Who | Notes |
|---|---|---|
| Choose and buy the production domain; real root e-mails for the staging and prod accounts | Owner | Terraform will refuse `.example` once T-0057 lands |
| AWS: apply `bootstrap`, `envs/shared`, set the three repository variables | Admin | `docs/setup/release.md` |
| GitHub environments `staging` and `prod` with required reviewers; Actions minutes | Owner | the deploy workflow depends on them |
| Vendor contracts and sandbox credentials: Stripe, Twilio, Postmark, Expo, Airalo, Cover Genius, WorkOS, Apple, Google | Owner | each as `request_credential` / `put-secret-value`, never in the repo |
| ADR-006: card processor, sponsor bank, KYC, FX and payout rails | Owner | blocks every money flag |
| Apple Developer and Google Play accounts, store listings, privacy labels, review submission | Owner | T-0058 documents the steps |
| Client VPN identity application and admin OIDC client | Admin | `infra/terraform/README.md` step 6 |
| Pager vendor, on-call rota, `#incidents`, external status page | Owner | T-0054 takes the endpoint as a variable |
| Legal text (terms, privacy, disclosures) and plan prices entered through the console | Counsel / Finance | two-person approved |
| Penetration test, SOC 2 evidence, bank sign-off on `docs/bank-review/` | Owner | folders exist; sessions are scheduled outside the repo |
| Webhook provider IP ranges into `webhook_provider_cidrs` | Admin | listed in `docs/setup/secrets.md` (T-0056) |

## Go / no-go for a production pilot

All of: T-0040 to T-0062 merged; T-0060 recorded green on staging; D1 to D3 answered; the table above ticked; a
second person has read the prod `terraform plan`. Money flags stay off until ADR-006 and their own release gates.
