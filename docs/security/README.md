# Security

Where the security evidence for Kesher Club lives (T-0014, CLUB-38). Start here, then follow the link
for the reader you are.

| Reader | Start at |
|---|---|
| External penetration testers | [pentest/README.md](pentest/README.md): scope, rules of engagement, where findings go |
| SOC 2 auditor | [soc2/README.md](soc2/README.md): control → artefact → owner |
| On-call engineer | [../runbooks/README.md](../runbooks/README.md): one runbook per paging alert |

## What runs on every pull request

| Check | Where | Fails the PR when |
|---|---|---|
| Semgrep | `.github/workflows/ci.yml`, job "Semgrep" | a rule matches |
| `pnpm audit` | `.github/workflows/ci.yml`, job "pnpm audit" | a dependency advisory at the configured level |
| tfsec | `.github/workflows/ci.yml`, job "tfsec (infra/terraform)" | an infrastructure misconfiguration |
| OpenAPI lint and breaking-change check | `.github/workflows/ci.yml`, job "Spectral + oasdiff" | the contract breaks or a rule fails |
| Schemathesis | `.github/workflows/preview.yml`, job "Schemathesis against the preview" | the live API disagrees with `contracts/openapi.yaml` |
| OWASP ZAP baseline | `.github/workflows/preview.yml`, job "ZAP baseline against the preview" | any alert of High risk |

The two preview jobs run once the preview environment exists, which needs the shared infrastructure
applied and its outputs stored as repository variables (`vars.AWS_CI_ROLE_ARN`). Until then GitHub
shows them as skipped.

## Rules the code already enforces

These come from `docs/constitution.md` and are worth knowing before testing anything.

- Ports before vendors (article 1): no vendor SDK outside `packages/adapters`.
- Ledger is law (article 3): `ledger.*` is insert-only; corrections are reversing journals.
- Fail secure (article 6): missing configuration stops the process at boot.
- Least data (article 9): vendor ids live only in `ops.external_ref`; secrets are wrapped so they print as `[redacted]` (`packages/domain/src/config.ts`).
