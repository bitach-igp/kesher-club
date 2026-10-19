# SOC 2 evidence index

Read this first. Each row names a control, the artefact that evidences it, and the role that owns it.
Artefacts in the repository are cited by path; anything kept outside the repository says where.

Owner of this index: security lead · Last updated with T-0014.

## Security (common criteria)

| Control | Artefact | Owner |
|---|---|---|
| CC6.1 Logical access, members | Passkeys as the main credential and a fresh step-up for money actions: `apps/api/src/auth/`, `apps/api/src/auth/step-up.ts` | engineering lead |
| CC6.1 Logical access, staff | Staff tokens from the company identity provider, checked per route: `apps/api/src/admin/staff-token.ts` | security lead |
| CC6.2, CC6.3 Staff provisioning and removal | Kept in the company identity provider, outside this repository | security lead |
| CC6.6 Threats from outside | Semgrep and dependency audit per PR (`.github/workflows/ci.yml`); ZAP baseline and Schemathesis per preview (`.github/workflows/preview.yml`); pentest scope in [../pentest/README.md](../pentest/README.md) | security lead |
| CC6.7 Data in transit | TLS at the load balancer: `infra/terraform/modules/alb/` | engineering lead |
| CC6.8 Malicious or vulnerable software | `pnpm audit` job in `.github/workflows/ci.yml`; vendor SDKs only behind ports (`docs/constitution.md` article 1) | engineering lead |
| CC7.1 Configuration and vulnerability management | tfsec and `terraform validate` jobs in `.github/workflows/ci.yml`; every flag listed in `config/flags.json` | engineering lead |
| CC7.2 Monitoring | Paging alerts and thresholds: `docs/runbooks/README.md`; transaction monitoring rules: `apps/worker/src/monitoring/rules.ts` | on-call engineer |
| CC7.3 to CC7.5 Incident response | Runbooks RUN-01 to RUN-08 in `docs/runbooks/`; kill switches with member-facing incident copy: `apps/api/src/flags/service.ts`, `apps/api/src/status/handler.ts` | security lead |
| CC8.1 Change management | One task card per pull request (`CLAUDE.md`, `specs/tasks/`); CI must be green; contract breaking-change check (oasdiff in `.github/workflows/ci.yml`); migration lint (`pnpm db:lint`) | engineering lead |
| CC9.2 Vendor management | Every external capability is a port with a simulator and a contract suite: `packages/ports/src/catalogue.ts` | engineering lead |

## Availability

| Control | Artefact | Owner |
|---|---|---|
| A1.2 Backups and recovery | Encrypted database with configurable backup retention and deletion protection: `infra/terraform/modules/rds/main.tf`; restore procedure: `docs/runbooks/RUN-08-restore-from-backup.md` | engineering lead |

## Processing integrity

| Control | Artefact | Owner |
|---|---|---|
| PI1 Complete and accurate money movement | Double-entry ledger that sums to zero per currency, insert-only: `db/migrations/ledger/`, `apps/api/src/ledger/post.ts`; every movement is a transfer with an idempotency key: `apps/api/src/transfers/service.ts` | finance lead |
| PI1 Two-person approval | Flag flips, provider bindings, ledger corrections, payouts and manual rates: `apps/api/src/approvals/service.ts` | finance lead |
| PI1 Tamper-evident audit | Hash-chained audit log with a verify endpoint: `apps/api/src/audit/service.ts`, `GET /v1/admin/audit/verify` | security lead |

## Confidentiality and privacy

| Control | Artefact | Owner |
|---|---|---|
| C1.1 Confidential data | Least data and vendor ids only in `ops.external_ref` (`docs/constitution.md` article 9); secrets print as `[redacted]` (`packages/domain/src/config.ts`); no static cloud keys, OIDC only (`.github/workflows/preview.yml`) | security lead |
| P-series Consent and disclosures | Legal versions and when consent is re-asked: `docs/bank-review/disclosures.md` | compliance lead |

Open: the auditor's period, the in-scope trust services criteria, and the evidence collection tool
are not chosen yet. The security lead decides with the auditor.
