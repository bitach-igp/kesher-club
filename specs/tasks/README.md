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
| [T-0012](T-0012.md) | SETUP | Migration safety lint without Atlas Pro (Squawk), and move the balance cache to ops.account_balance | — | 2 |
| [T-0013](T-0013.md) | SETUP | Hebrew/RTL full pass and Dynamic Type 200% (CLUB-37) | — | 9 |
| [T-0014](T-0014.md) | SETUP | Pentest readiness: ZAP baseline on the preview, evidence folders (CLUB-38) | — | 9 |
| [T-0015](T-0015.md) | SETUP | File paths from import.meta.url work on Windows | — | 9 |
| [T-0016](T-0016.md) | SETUP | Simulators boot under Node strip-only type stripping (no parameter properties in runtime packages) | — | 9 |
| [T-0017](T-0017.md) | SETUP | api, worker and adapters load under Node strip-only type stripping (after T-0016) | — | 9 |
| [T-0020](T-0020.md) | SETUP | Postgres driver binding and the process config | — | 9 |
| [T-0021](T-0021.md) | SETUP | The API runs as a process | — | 9 |
| [T-0022](T-0022.md) | SETUP | The worker runs every sweep on its cycle | — | 9 |
| [T-0023](T-0023.md) | SETUP | The worker runs the nightly jobs at their Israel times | — | 9 |
| [T-0024](T-0024.md) | SETUP | Field-level PII sealing with a blind index | — | 9 |
| [T-0025](T-0025.md) | SETUP | The containers get the config the processes read | — | 9 |
| [T-0026](T-0026.md) | SETUP | One API, worker and JIT service per market | — | 9 |
| [T-0027](T-0027.md) | SETUP | Rows record the market whose API created them | — | 9 |
| [T-0028](T-0028.md) | SETUP | Each market's worker sweeps only its own market's rows | — | 9 |
| [T-0110](T-0110.md) | AUTH | OTP start/verify + passkey register | REQ-AUTH-001 | 1 |
| [T-0111](T-0111.md) | AUTH | Passkey authenticate + device binding | REQ-AUTH-002 | 2 |
| [T-0112](T-0112.md) | AUTH | Token service: 10-min access, rotating refresh, family revocation | REQ-AUTH-007 | 2 |
| [T-0113](T-0113.md) | AUTH | Mobile sign-in screens M03-M04 with Expo passkeys | REQ-AUTH-001, REQ-AUTH-002 | 2 |
| [T-0114](T-0114.md) | AUTH | Recovery restriction state + device notifications | REQ-AUTH-003 | 2 |
| [T-0115](T-0115.md) | AUTH | Step-up endpoint + StepUp component | REQ-AUTH-006 | 2 |
| [T-0116](T-0116.md) | AUTH | Admin SSO + VPN-only middleware | REQ-AUTH-009 | 2 |
| [T-0117](T-0117.md) | AUTH | FederatedIdPPort simulator + Apple/Google adapters | REQ-AUTH-004, REQ-AUTH-005 | 2 |
| [T-0118](T-0118.md) | AUTH | OrgIdPPort simulator + vendor adapter per ADR-004 | REQ-AUTH-008 | 2 |
| [T-0119](T-0119.md) | AUTH | Identity is stored in Postgres | REQ-AUTH-001 | 9 |
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
| [T-0401](T-0401.md) | CRD | KYC sessions and tiers over KycPort (simulator) | — | 4 |
| [T-0402](T-0402.md) | CRD | Virtual card issue within 60 s of T2 approval; details token only | REQ-CRD-001, REQ-CRD-002 | 5 |
| [T-0403](T-0403.md) | CRD | JIT authorisation decision, fail closed, p99 < 300 ms | REQ-CRD-003 | 5 |
| [T-0404](T-0404.md) | CRD | Freeze cascade to tokens; funder controls override and lock | REQ-CRD-004, REQ-CRD-005 | 5 |
| [T-0405](T-0405.md) | CRD | Push provisioning + token lifecycle webhooks | REQ-CRD-006, REQ-CRD-007 | 5 |
| [T-0406](T-0406.md) | CRD | Agent purchases: off / with approval / under amount | REQ-CRD-008 | 6 |
| [T-0407](T-0407.md) | CRD | Physical cards: order, tracking, activation, PIN | REQ-CRD-009 | 6 |
| [T-0408](T-0408.md) | CRD | Mobile screens M06, M20–M24 | — | 6 |
| [T-0409](T-0409.md) | CRD | A shekel card payment draws on the shekel purse at the club rate | REQ-CRD-003 | 9 |
| [T-0410](T-0410.md) | CRD | Card settlement: clearing moves the hold, unclaimed holds release after 7 days | REQ-CRD-003 | 9 |
| [T-0501](T-0501.md) | WAL | Loads by card, Apple Pay, Google Pay + load workflow | REQ-WAL-002 | 5 |
| [T-0502](T-0502.md) | WAL | ACH holds and release | REQ-WAL-003 | 5 |
| [T-0503](T-0503.md) | WAL | Auto-reload, once per 24 h | REQ-WAL-004 | 6 |
| [T-0504](T-0504.md) | WAL | Closure refund or withdrawal | REQ-WAL-005 | 6 |
| [T-0505](T-0505.md) | PAY | P2P send: limits, idempotency, journals, notify | REQ-PAY-001, REQ-PAY-002, REQ-PAY-005 | 6 |
| [T-0506](T-0506.md) | PAY | New-pair 2 h hold with cancel | REQ-PAY-003 | 6 |
| [T-0507](T-0507.md) | PAY | Requests and splits, 14-day expiry | REQ-PAY-004 | 6 |
| [T-0508](T-0508.md) | PAY | Mobile screens M12–M19 | — | 6 |
| [T-0509](T-0509.md) | FX | Quotes with 30 s lock, plan markup on the journal, M11 | REQ-FX-001, REQ-FX-002 | 6 |
| [T-0510](T-0510.md) | PO | Payouts: payee validation, cool-off, two-person approval, auto-reverse | REQ-PO-001, REQ-PO-002 | 8 |
| [T-0511](T-0511.md) | WAL | Mobile screens M08–M10 | — | 5 |
| [T-0512](T-0512.md) | FX | Club rate table, two-person manual rates, admin rate API | REQ-FX-003, REQ-ADM-003 | 9 |
| [T-0513](T-0513.md) | FX | Quotes and conversions at the club rate; port refresh and staleness | REQ-FX-003, REQ-FX-004 | 9 |
| [T-0514](T-0514.md) | PAY | Receiving currency preference | REQ-PAY-007 | 9 |
| [T-0515](T-0515.md) | PAY | Cross-currency send at the club rate | REQ-PAY-006 | 9 |
| [T-0516](T-0516.md) | PAY | Mobile purse choice, received-amount preview, receiving currency setting | REQ-PAY-006, REQ-PAY-007 | 9 |
| [T-0517](T-0517.md) | WAL | Loads into the chosen purse; cross-currency loads at the club rate | REQ-WAL-006 | 9 |
| [T-0518](T-0518.md) | PAY | Send preview: what a send lands as, priced as the send prices it | REQ-PAY-006 | 9 |
| [T-0519](T-0519.md) | WAL | A load into the other purse carries the plan markup | REQ-WAL-006 | 9 |
| [T-0520](T-0520.md) | FX | A failed vendor leg closes the conversion | REQ-FX-001 | 9 |
| [T-0521](T-0521.md) | WAL | Closure refunds a converted load pro rata at the load's rate | REQ-WAL-005 | 9 |
| [T-0522](T-0522.md) | FX | Durable FX quotes before a second API instance | REQ-FX-001 | scale-out |
| [T-0523](T-0523.md) | WAL | Closure keeps the conversion markup | REQ-WAL-005 | 9 |
| [T-0601](T-0601.md) | INS | Roster import all-or-nothing | REQ-INS-001 | 2 |
| [T-0602](T-0602.md) | INS | Invite fan-out + funnel | REQ-INS-002 | 2 |
| [T-0603](T-0603.md) | INS | RLS + consent grant | REQ-INS-005 | 8 |
| [T-0604](T-0604.md) | INS | Allowance schedules + dry run + workflow | REQ-INS-003 | 8 |
| [T-0605](T-0605.md) | INS | Two-person approval service | REQ-INS-004, REQ-ADM-002 | 8 |
| [T-0606](T-0606.md) | INS | Collections receipts + monthly reconciliation export | REQ-INS-006 | 8 |
| [T-0607](T-0607.md) | INS | Allowance runs: endpoint, a transfer per payment, the money flag | REQ-INS-003 | 9 |
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
| [T-0906](T-0906.md) | ADM | Admin API: staff token, flags, bindings, audit (ADR-013) | REQ-ADM-001, REQ-ADM-002 | 5 |
| [T-0907](T-0907.md) | ADM | Admin API: customer search + Customer 360 | — | 5 |
| [T-0908](T-0908.md) | ADM | Complaints table, admin complaint + alert endpoints | REQ-CMP-002 | 5 |
| [T-0909](T-0909.md) | CMP | Monitoring rules v1: velocity, structuring, fan-in/out | REQ-CMP-001 | 6 |
| [T-0910](T-0910.md) | ADM | Runbooks RUN-01 to RUN-08, alert index, on-call rota (CLUB-39) | — | 9 |
| [T-0911](T-0911.md) | ADM | Status endpoint and incident banner wired to the kill switches (CLUB-39) | — | 9 |
| [T-0912](T-0912.md) | CMP | Bank-review package (CLUB-40) | — | 9 |
| [T-0913](T-0913.md) | ADM | The console reaches each market's API | — | 9 |
| [T-0914](T-0914.md) | ADM | The console gets its config; only VPN traffic passes its IP gate | REQ-AUTH-009 | 9 |
| [T-0915](T-0915.md) | ADM | The console builds, with no settings, into one image for every environment | REQ-AUTH-009 | 9 |
| [T-1001](T-1001.md) | AGT | Protected Resource Metadata + 401 | REQ-AGT-001 | 10 |
| [T-1002](T-1002.md) | AGT | Token validation: audience, scopes, grant | REQ-AGT-002, REQ-AGT-005 | 10 |
| [T-1003](T-1003.md) | AGT | CIMD registration with SSRF guard | REQ-AGT-003 | 10 |
| [T-1004](T-1004.md) | AGT | T0 tools from OpenAPI + untrusted wrapping | REQ-AGT-007 | 10 |
| [T-1005](T-1005.md) | AGT | Pending-intent service + approval | REQ-AGT-006 | 10 |
| [T-1006](T-1006.md) | AGT | Grants screen, revoke, rate limits | REQ-AGT-008, REQ-AGT-009 | 10 |
| [T-1007](T-1007.md) | AGT | Provider calls never carry a user token | REQ-AGT-004 | 10 |
| [T-1008](T-1008.md) | AGT | An approved agent send runs the member's own send path | REQ-AGT-006 | 10 |
| [T-1009](T-1009.md) | AGT | Approving a load intent runs the member's load | REQ-AGT-006 | 10 |
| [T-1010](T-1010.md) | AGT | Intent expiry sweep in the worker, never past a started send | REQ-AGT-006 | 10 |
E04 (card + push provisioning) and E05 (wallet, P2P, FX, payouts) are built against the simulators (ADR-006, 2026-10-17); the processor adapter is a later card once the vendor is signed.
