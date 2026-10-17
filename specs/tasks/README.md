# Task index

| Task | Epic | Title | REQ | Sprint |
|---|---|---|---|---|
| [T-0001](T-0001.md) | SETUP | Monorepo scaffold (pnpm, Turborepo, TS strict, ESLint incl. money-number ban) | — | 1 |
| [T-0002](T-0002.md) | SETUP | CI workflow: lint, typecheck, unit, Spectral, Semgrep, tfsec, audit | — | 1 |
| [T-0003](T-0003.md) | SETUP | Terraform base: accounts, VPC, RDS, ECS, KMS, Secrets | — | 1 |
| [T-0004](T-0004.md) | SETUP | Config loader with Zod, crash on missing secrets | — | 1 |
| [T-0005](T-0005.md) | SETUP | Migration tooling (Atlas) + DB roles club_app, club_migrator | — | 1 |
| [T-0006](T-0006.md) | SETUP | Tokens package + Style Dictionary outputs | — | 1 |
| [T-0007](T-0007.md) | SETUP | OpenAPI skeleton + SDK generation + Schemathesis job | — | 1 |
| [T-0008](T-0008.md) | SETUP | Port interfaces for all 18 ports + empty contract suites | — | 1 |
| [T-0009](T-0009.md) | SETUP | Simulator host + control panel; first simulator: Billing | — | 1 |
| [T-0010](T-0010.md) | SETUP | Preview environments per PR | — | 1 |
| [T-0011](T-0011.md) | SETUP | Atlas apply in dependency order with per-schema baseline | — | 2 |
| [T-0012](T-0012.md) | SETUP | Atlas lint without Pro, and the ledger.account_balance grant vs constitution art. 3 | — | 2 |
| [T-0110](T-0110.md) | AUTH | OTP start/verify + passkey register | REQ-AUTH-001 | 1 |
| [T-0111](T-0111.md) | AUTH | Passkey authenticate + device binding | REQ-AUTH-002 | 2 |
| [T-0112](T-0112.md) | AUTH | Token service: 10-min access, rotating refresh, family revocation | REQ-AUTH-007 | 2 |
| [T-0113](T-0113.md) | AUTH | Mobile sign-in screens M03-M04 with Expo passkeys | REQ-AUTH-001, REQ-AUTH-002 | 2 |
| [T-0114](T-0114.md) | AUTH | Recovery restriction state + device notifications | REQ-AUTH-003 | 2 |
| [T-0115](T-0115.md) | AUTH | Step-up endpoint + StepUp component | REQ-AUTH-006 | 2 |
| [T-0116](T-0116.md) | AUTH | Admin SSO + VPN-only middleware | REQ-AUTH-009 | 2 |
| [T-0117](T-0117.md) | AUTH | FederatedIdPPort simulator + Apple/Google adapters | REQ-AUTH-004, REQ-AUTH-005 | 2 |
| [T-0118](T-0118.md) | AUTH | OrgIdPPort simulator + vendor adapter per ADR-004 | REQ-AUTH-008 | 2 |
| [T-0201](T-0201.md) | LED | Ledger core post() + invariant trigger (port the reference Ledger to Postgres) | REQ-LED-001, REQ-LED-002 | 4 |
| [T-0202](T-0202.md) | LED | Account provisioning per party and currency | REQ-WAL-001 | 4 |
| [T-0203](T-0203.md) | LED | Balance materialisation + nightly proof | — | 4 |
| [T-0204](T-0204.md) | LED | Inbound webhook store, verify, dedupe, replay | REQ-LED-003 | 4 |
| [T-0205](T-0205.md) | LED | Transfer state machine + outbox publisher | — | 4 |
| [T-0206](T-0206.md) | LED | Reconciliation job + ops cases | REQ-LED-004 | 4 |
| [T-0301](T-0301.md) | BIL | Stripe adapter incl. Apple/Google Pay | — | 3 |
| [T-0302](T-0302.md) | BIL | Plans, versions, entitlement templates, can() + /me/capabilities | — | 3 |
| [T-0303](T-0303.md) | BIL | Dunning, pause/resume, 10-month term | — | 3 |
| [T-0304](T-0304.md) | BIL | Legal CMS: versions, consent, re-accept | — | 3 |
| [T-0601](T-0601.md) | INS | Roster import all-or-nothing | REQ-INS-001 | 2 |
| [T-0602](T-0602.md) | INS | Invite fan-out + funnel | REQ-INS-002 | 2 |
| [T-0603](T-0603.md) | INS | RLS + consent grant | REQ-INS-005 | 8 |
| [T-0604](T-0604.md) | INS | Allowance schedules + dry run + workflow | REQ-INS-003 | 8 |
| [T-0605](T-0605.md) | INS | Two-person approval service | REQ-INS-004, REQ-ADM-002 | 8 |
| [T-0701](T-0701.md) | MKT | addon_order lifecycle + ledger postings | REQ-MKT-001 | 7 |
| [T-0702](T-0702.md) | MKT | Catalogue sync + price rules | REQ-MKT-002 | 7 |
| [T-0710](T-0710.md) | MKT | Airalo adapter (must pass esimContract) | REQ-ESIM-001 | 7 |
| [T-0711](T-0711.md) | MKT | Entitlement credit at checkout | REQ-ESIM-002 | 7 |
| [T-0712](T-0712.md) | MKT | Usage polling + notifications | REQ-ESIM-003 | 7 |
| [T-0713](T-0713.md) | MKT | Screens M25-M28 | REQ-ESIM-001 | 7 |
| [T-0720](T-0720.md) | MKT | Cover Genius adapter + disclosure checkout | REQ-INSR-001 | 7 |
| [T-0730](T-0730.md) | MKT | Concierge bridge + emergency flow M31-M32 | — | 7 |
| [T-0801](T-0801.md) | NOT | NotifyPort with preferences + quiet hours | REQ-NOT-001 | 6 |
| [T-0802](T-0802.md) | NOT | Expo push + Postmark + Twilio adapters | — | 6 |
| [T-0803](T-0803.md) | NOT | Standard Webhooks outbound + replay UI | REQ-NOT-002 | 8 |
| [T-0901](T-0901.md) | ADM | Admin shell, Customer 360 | — | 2 |
| [T-0902](T-0902.md) | ADM | Providers & Flags screen with release gates | — | 2 |
| [T-0903](T-0903.md) | ADM | Hash-chained audit + verification | REQ-ADM-001 | 9 |
| [T-0904](T-0904.md) | ADM | Compliance alerts + complaint SLAs | REQ-CMP-002 | 9 |
| [T-0905](T-0905.md) | ADM | Two-person flag flip | REQ-ADM-002 | 9 |
| [T-1001](T-1001.md) | AGT | Protected Resource Metadata + 401 | REQ-AGT-001 | 10 |
| [T-1002](T-1002.md) | AGT | Token validation: audience, scopes, grant | REQ-AGT-002, REQ-AGT-005 | 10 |
| [T-1003](T-1003.md) | AGT | CIMD registration with SSRF guard | REQ-AGT-003 | 10 |
| [T-1004](T-1004.md) | AGT | T0 tools from OpenAPI + untrusted wrapping | REQ-AGT-007 | 10 |
| [T-1005](T-1005.md) | AGT | Pending-intent service + approval | REQ-AGT-006 | 10 |
| [T-1006](T-1006.md) | AGT | Grants screen, revoke, rate limits | REQ-AGT-008, REQ-AGT-009 | 10 |

E04 (card + push provisioning) and E05 (P2P, FX, payouts) are generated once ADR-006 picks the processor.
