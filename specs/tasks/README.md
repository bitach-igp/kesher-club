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
| [T-0008](T-0008.md) | SETUP | Port interfaces for all 21 ports + empty contract suites | — | 1 |
| [T-0009](T-0009.md) | SETUP | Simulator host + control panel; first simulator: Billing | — | 1 |
| [T-0010](T-0010.md) | SETUP | Preview environments per PR | — | 1 |
| [T-0011](T-0011.md) | SETUP | Atlas apply in dependency order with per-schema baseline | — | 2 |
| [T-0012](T-0012.md) | SETUP | Migration safety lint without Atlas Pro (Squawk), and move the balance cache to ops.account_balance | — | 2 |
| [T-0013](T-0013.md) | SETUP | Hebrew/RTL full pass and Dynamic Type 200% (CLUB-37) | — | 9 |
| [T-0014](T-0014.md) | SETUP | Pentest readiness: ZAP baseline on the preview, evidence folders (CLUB-38) | — | 9 |
| [T-0015](T-0015.md) | SETUP | File paths from import.meta.url work on Windows | — | 9 |
| [T-0016](T-0016.md) | SETUP | Simulators boot under Node strip-only type stripping (no parameter properties in runtime packages) | — | 9 |
| [T-0017](T-0017.md) | SETUP | api, worker and adapters load under Node strip-only type stripping (after T-0016) | — | 9 |
| [T-0018](T-0018.md) | SETUP | erasableSyntaxOnly from tsconfig.base.json for every package (after T-0017) | — | 9 |
| [T-0020](T-0020.md) | SETUP | Postgres driver binding and the process config | — | 9 |
| [T-0021](T-0021.md) | SETUP | The API runs as a process | — | 9 |
| [T-0022](T-0022.md) | SETUP | The worker runs every sweep on its cycle | — | 9 |
| [T-0023](T-0023.md) | SETUP | The worker runs the nightly jobs at their Israel times | — | 9 |
| [T-0024](T-0024.md) | SETUP | Field-level PII sealing with a blind index | — | 9 |
| [T-0025](T-0025.md) | SETUP | The containers get the config the processes read | — | 9 |
| [T-0026](T-0026.md) | SETUP | One API, worker and JIT service per market | — | 9 |
| [T-0027](T-0027.md) | SETUP | Rows record the market whose API created them | — | 9 |
| [T-0028](T-0028.md) | SETUP | Each market's worker sweeps only its own market's rows | — | 9 |
| [T-0029](T-0029.md) | SETUP | CI runs on pull requests only | — | 9 |
| [T-0030](T-0030.md) | SETUP | Images reach ECR: a release workflow builds api, worker and admin and pushes immutable tags | — | 10 |
| [T-0031](T-0031.md) | SETUP | One local process runs API, jobs and simulator panel on one registry and clock | — | 10 |
| [T-0032](T-0032.md) | SETUP | Demo seed: the personas the eighteen money flows need | — | 10 |
| [T-0033](T-0033.md) | SETUP | The member app runs in a browser (Expo web) against the local stack | — | 10 |
| [T-0034](T-0034.md) | SETUP | The demo seed onboards the yeshiva, its finance pair and a roster through the admin API | REQ-ADM-004 | 11 |
| [T-0035](T-0035.md) | SETUP | The demo's shared clock reaches every API request | REQ-ADM-004 | 11 |
| [T-0036](T-0036.md) | SETUP | The mobile layout tests warm their module graph, so CI's first test does not time out | REQ-AUTH-001 | 12 |
| [T-0037](T-0037.md) | SETUP | The README says where the project stands; the six ADR drafts are recorded as accepted | — | 12 |
| [T-0038](T-0038.md) | SETUP | The AuthPort contract measures OTP expiry on the port's own clock, not the wall clock | REQ-AUTH-001 | 15 |
| [T-0040](T-0040.md) | SETUP | Per-port provider binding: PROVIDER_<PORT> picks sim or an adapter, PROVIDER_MODE_DEFAULT may be sandbox | — | 16 deploy |
| [T-0041](T-0041.md) | SETUP | Bind the Stripe (funding, billing) and notification adapters (Twilio, Postmark, Expo push) by config | — | 16 deploy |
| [T-0042](T-0042.md) | SETUP | Bind the marketplace (Airalo, Cover Genius) and identity (WorkOS, Apple, Google) adapters by config | — | 16 deploy |
| [T-0043](T-0043.md) | SETUP | Production boots on simulators only for ports whose flags are off | — | 16 deploy |
| [T-0044](T-0044.md) | SETUP | The database is prepared from inside the VPC: a migrate task creates roles, sets passwords and applies every schema | — | 16 deploy |
| [T-0045](T-0045.md) | SETUP | The JIT service connects as club_jit, with its own password (after T-0063, T-0064) | — | 16 deploy |
| [T-0046](T-0046.md) | SETUP | Production bootstrap: a one-time idempotent command creates the system accounts (first admin, legal and plan shells reported as blocked or not needed) | — | 16 deploy |
| [T-0047](T-0047.md) | SETUP | The institution console ships as an image and runs as a service, not a static bucket | — | 16 deploy |
| [T-0048](T-0048.md) | SETUP | apps/web: marketing, versioned legal pages and the domain-association files, as a static site on the existing bucket | — | 16 deploy |
| [T-0049](T-0049.md) | SETUP | Release hardening: ECR scan gate, SBOM, pinned base images and the console image in the release | — | 16 deploy |
| [T-0050](T-0050.md) | SETUP | Deploy workflow: staging on demand, production behind approval, migrate first, roll back by tag | — | 16 deploy |
| [T-0051](T-0051.md) | SETUP | A smoke suite that proves a deployed environment works | — | 16 deploy |
| [T-0052](T-0052.md) | SETUP | Structured logging with redaction and a request id | — | 16 deploy |
| [T-0053](T-0053.md) | SETUP | The metrics the runbooks alert on are emitted | — | 16 deploy |
| [T-0054](T-0054.md) | SETUP | Alarms, paging, dashboards and budgets in Terraform, one per runbook alert | — | 16 deploy |
| [T-0055](T-0055.md) | SETUP | A JIT load test with the p99 under 300 ms gate | — | 16 deploy |
| [T-0056](T-0056.md) | SETUP | Secrets: a tool that generates and loads key material without printing it, and the rotation steps | — | 16 deploy |
| [T-0057](T-0057.md) | SETUP | Mail and domain records in Terraform: SPF, DKIM, DMARC, CAA, return path | — | 16 deploy |
| [T-0058](T-0058.md) | SETUP | Mobile release plumbing: bundle ids, EAS profiles, associated domains and build-time config per environment | — | 16 deploy |
| [T-0059](T-0059.md) | SETUP | Mobile native bindings: passkeys, secure token store, device facts, push registration | — | 16 deploy |
| [T-0060](T-0060.md) | SETUP | Staging acceptance: a full deploy from nothing, the sandbox end-to-end run and a restore drill | — | 16 deploy |
| [T-0061](T-0061.md) | BIL | The legal documents over HTTP: current versions, accept, re-accept gate | — | 16 deploy |
| [T-0063](T-0063.md) | SETUP | A JIT process: SERVICE_ROLE=jit serves only the card authorisation route and the status | — | 16 deploy |
| [T-0064](T-0064.md) | SETUP | club_jit can run the card authorisation: the grants it needs and a real-Postgres decision test | — | 16 deploy |
| [T-0065](T-0065.md) | BIL | Legal documents: draft and publish through the two-person flow | — | 16 deploy |
| [T-0066](T-0066.md) | BIL | A member who has not accepted the current terms is stopped at money routes (behind a flag) | — | 16 deploy |
| [T-0067](T-0067.md) | BIL | legal.consent.ip is nullable: a consent no longer records an address it does not collect | — | 16 deploy |
| [T-0068](T-0068.md) | SETUP | The console's large requests pass the WAF: a roster import is not blocked at 8 KB | — | 16 deploy |
| [T-0069](T-0069.md) | SETUP | The console-to-API hop does not record the NAT gateway as the client address | — | 16 deploy |
| [T-0070](T-0070.md) | SETUP | Prod is reachable only from the prod environment job: per-environment CI roles or deploy-role trust on the OIDC subject | — | 16 deploy |
| [T-0071](T-0071.md) | SETUP | AuditService.record is refused under club_app on a real Postgres: serialise the hash chain with an advisory lock, not a table lock | — | 16 deploy |
| [T-0072](T-0072.md) | SETUP | Needs owner decision: where the first Kesher admin lives, and whether legal documents get a draft state | — | 16 deploy |
| [T-0062](T-0062.md) | BIL | The app shows the terms at sign-up and re-accept, and links them from settings | — | 16 deploy |
| [T-0073](T-0073.md) | SETUP | Re-record the committed screenshots after the navy and sky redesign | — | 16 deploy |
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
| [T-0120](T-0120.md) | AUTH | Passkey ceremonies declare the install's deviceId; the app sends it | REQ-AUTH-001 | 10 |
| [T-0201](T-0201.md) | LED | Ledger core post() + invariant trigger (port the reference Ledger to Postgres) | REQ-LED-001, REQ-LED-002 | 4 |
| [T-0202](T-0202.md) | LED | Account provisioning per party and currency | REQ-WAL-001 | 4 |
| [T-0203](T-0203.md) | LED | Balance materialisation + nightly proof | — | 4 |
| [T-0204](T-0204.md) | LED | Inbound webhook store, verify, dedupe, replay | REQ-LED-003 | 4 |
| [T-0205](T-0205.md) | LED | Transfer state machine + outbox publisher | — | 4 |
| [T-0206](T-0206.md) | LED | Reconciliation job + ops cases | REQ-LED-004 | 4 |
| [T-0207](T-0207.md) | LED | A forged webhook never claims a genuine event's id | REQ-LED-005 | 12 |
| [T-0301](T-0301.md) | BIL | Stripe adapter incl. Apple/Google Pay | — | 3 |
| [T-0302](T-0302.md) | BIL | Plans, versions, entitlement templates, can() + /me/capabilities | — | 3 |
| [T-0303](T-0303.md) | BIL | Dunning, pause/resume, 10-month term | — | 3 |
| [T-0304](T-0304.md) | BIL | Legal CMS: versions, consent, re-accept | — | 3 |
| [T-0305](T-0305.md) | BIL | Members see the plans offered in their market | REQ-BIL-001 | 13 |
| [T-0306](T-0306.md) | BIL | A funder invites a member onto a plan they pay for | REQ-BIL-002 | 13 |
| [T-0307](T-0307.md) | BIL | Accepting a funder's invite starts the membership, once | REQ-BIL-003 | 13 |
| [T-0308](T-0308.md) | BIL | Funder mode in the app: choose a plan, pay, invite your child (P01–P04) | REQ-BIL-001 | 13 |
| [T-0309](T-0309.md) | BIL | M04 accepts a funder's invite | REQ-BIL-003 | 13 |
| [T-0310](T-0310.md) | BIL | The funder's memberships, and cancelling one in two taps | REQ-BIL-004 | 14 |
| [T-0311](T-0311.md) | BIL | P13 billing in funder mode | REQ-BIL-004 | 14 |
| [T-0312](T-0312.md) | BIL | Fix: creating a membership needs step-up, the flag and the member's consent | REQ-BIL-002, REQ-BIL-003 | fix |
| [T-0313](T-0313.md) | BIL | Fix: one non-cancelled membership per member, enforced by the database | REQ-BIL-002, REQ-BIL-003 | fix |
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
| [T-0411](T-0411.md) | CRD | A card hold refunds the markup on what was not spent | REQ-CRD-003 | 9 |
| [T-0412](T-0412.md) | CRD | P09 the funder sets a member's card controls | REQ-CRD-005 | 14 |
| [T-0413](T-0413.md) | CRD | The accounts a card authorisation needs exist before the first authorisation | REQ-CRD-003 | 16 deploy |
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
| [T-0524](T-0524.md) | WAL | P07 Add money, one-time: card, Apple Pay, Google Pay or ACH into either purse | REQ-WAL-002, REQ-WAL-003, REQ-WAL-006 | 11 |
| [T-0525](T-0525.md) | WAL | P07 Auto-reload: top up to a target below a threshold | REQ-WAL-004 | 11 |
| [T-0526](T-0526.md) | WAL | M34 Close account: the balance is refunded before close | REQ-WAL-005 | 11 |
| [T-0527](T-0527.md) | PO | Institution payouts reach HTTP: request, list, second approver decides | REQ-PO-001, REQ-PO-002, REQ-INS-004 | 11 |
| [T-0528](T-0528.md) | PAY | Member app binds the device: Pay, Card, eSIM and Emergency open | REQ-PAY-001, REQ-ESIM-001 | 11 |
| [T-0529](T-0529.md) | PAY | Member app reaches pay home and receiving currency; Home says only what is locked | REQ-PAY-004, REQ-PAY-007 | 12 |
| [T-0530](T-0530.md) | PAY | Confirm sheet names the recipient as resolved, never by party id | REQ-PAY-001 | 12 |
| [T-0531](T-0531.md) | PAY | Members set the name others see: first name and last initial, sealed; API and demo seed | REQ-PAY-008 | 12 |
| [T-0532](T-0532.md) | PAY | The member app's "Your name" screen, reached from Home | REQ-PAY-008 | 12 |
| [T-0533](T-0533.md) | FX | The rate lock counts down on the quote's own clock, not the phone's | REQ-FX-001 | 12 |
| [T-0534](T-0534.md) | WAL | The funder's household: each member they fund, with balances and last spend | REQ-WAL-007 | 13 |
| [T-0535](T-0535.md) | WAL | P05 family dashboard in funder mode | REQ-WAL-007 | 13 |
| [T-0536](T-0536.md) | WAL | Members see each purse's transactions | REQ-WAL-008 | 14 |
| [T-0537](T-0537.md) | WAL | A funder sees a funded member's activity: transactions, spend by category, cards | REQ-WAL-009 | 14 |
| [T-0538](T-0538.md) | WAL | P06 child detail in funder mode | REQ-WAL-009 | 14 |
| [T-0539](T-0539.md) | WAL | Fix: a returned or failed ACH load is failed, never released to the wallet | REQ-WAL-003, REQ-LED-004 | fix |
| [T-0540](T-0540.md) | PO | Fix: reserve payout funds while a payout waits for cool-off or approval | REQ-PO-001, REQ-WAL-001 | fix |
| [T-0541](T-0541.md) | PO | Fix: a payout hit by a rail outage is retried, not stranded | REQ-PO-002 | fix |
| [T-0542](T-0542.md) | ESIM | Fix: add-on orders get a funds check, step-up and a validated quantity | REQ-ESIM-001, REQ-WAL-001 | fix |
| [T-0543](T-0543.md) | PAY | Fix: a P2P send left pending is finished once, never posted twice | REQ-PAY-003, REQ-PAY-005 | fix |
| [T-0544](T-0544.md) | LED | Fix: balance and limit checks hold a per-wallet lock, real-Postgres concurrency test | REQ-WAL-001, REQ-PAY-002, REQ-CRD-003 | fix |
| [T-0545](T-0545.md) | PO | Fix: payout approval thresholds, no orphaned member payouts, no splitting | REQ-PO-001, REQ-INS-020 | fix |
| [T-0546](T-0546.md) | FX | Fix: FX rate sanity bound and expiry; conversions reserve before the vendor call | REQ-FX-001, REQ-FX-003, REQ-FX-004 | fix |
| [T-0547](T-0547.md) | WAL | Fix: a fail racing a hold leaves no hold journal; UNKNOWN_LOAD stops stalling | REQ-WAL-003, REQ-LED-004 | fix |
| [T-0548](T-0548.md) | ESIM | Fix: a stuck add-on order is charged on replay; the missing tests | REQ-ESIM-001, REQ-WAL-001 | fix |
| [T-0549](T-0549.md) | PO | Fix: payout reserve hardening and one place for approval expiry | REQ-PO-001, REQ-WAL-001 | fix |
| [T-0550](T-0550.md) | PO | Fix: institution payouts reserve their money (after T-0554, T-0555) | REQ-PO-001, REQ-INS-020 | fix |
| [T-0551](T-0551.md) | FX | Fix: void-stale reports failed only; deviation case reopens; one 24 h constant | REQ-FX-001, REQ-FX-003, REQ-FX-004 | fix |
| [T-0552](T-0552.md) | LED | Fix: reversals carry the transfer they undo | REQ-LED-001, REQ-LED-004 | fix |
| [T-0553](T-0553.md) | PO | Fix: stranded payouts, test independence and the provider-change case | REQ-PO-002 | fix |
| [T-0554](T-0554.md) | PO | Fix: institution payout approvals expire | REQ-PO-001, REQ-INS-020 | fix |
| [T-0555](T-0555.md) | LED | Fix: institution payout-reserve account, counted as the institution's own money | REQ-PO-001, REQ-INS-006, REQ-INS-017, REQ-INS-021 | fix |
| [T-0556](T-0556.md) | PO | Fix: a member cancels a payout that is still cooling off | REQ-PO-001, REQ-WAL-001 | fix |
| [T-0557](T-0557.md) | ESIM | Fix: the loser of a same-key add-on create gives its credit back | REQ-ESIM-001, REQ-WAL-001 | fix |
| [T-0558](T-0558.md) | WAL | Fix: the load sweep asks the vendor about a held load once per interval | REQ-WAL-003, REQ-LED-004 | fix |
| [T-0661](T-0661.md) | INS | Fix: an allowance payment cannot overdraw the institution's account | REQ-INS-003, REQ-INS-008 | fix |
| [T-0601](T-0601.md) | INS | Roster import all-or-nothing | REQ-INS-001 | 2 |
| [T-0602](T-0602.md) | INS | Invite fan-out + funnel | REQ-INS-002 | 2 |
| [T-0603](T-0603.md) | INS | RLS + consent grant | REQ-INS-005 | 8 |
| [T-0604](T-0604.md) | INS | Allowance schedules + dry run + workflow | REQ-INS-003 | 8 |
| [T-0605](T-0605.md) | INS | Two-person approval service | REQ-INS-004, REQ-ADM-002 | 8 |
| [T-0606](T-0606.md) | INS | Collections receipts + monthly reconciliation export | REQ-INS-006 | 8 |
| [T-0607](T-0607.md) | INS | Allowance runs: endpoint, a transfer per payment, the money flag | REQ-INS-003 | 9 |
| [T-0608](T-0608.md) | INS | The institution console starts: finance staff sign in | REQ-INS-004 | 11 |
| [T-0609](T-0609.md) | INS | Allowance schedules and run history reach HTTP | REQ-INS-003, REQ-INS-004 | 11 |
| [T-0610](T-0610.md) | INS | I07 Allowances: preview, run, second approver | REQ-INS-003, REQ-INS-004 | 11 |
| [T-0611](T-0611.md) | INS | I08 Collections: who owes, receipts, monthly export | REQ-INS-006 | 11 |
| [T-0612](T-0612.md) | INS | I09 Payouts: request, cool-off, second approver | REQ-PO-001, REQ-PO-002, REQ-INS-004 | 11 |
| [T-0613](T-0613.md) | INS | Each institution has its own ledger account | REQ-INS-003, REQ-INS-006 | 11 |
| [T-0614](T-0614.md) | INS | Recorded institution deposits: record, second finance approves, posts once | REQ-INS-007 | 11 |
| [T-0615](T-0615.md) | ADM | Admin console: institutions, balances, recording and approving deposits | REQ-INS-007, REQ-ADM-004 | 11 |
| [T-0616](T-0616.md) | INS | Institution credit limit: two admins set it, allowance runs stop at it | REQ-INS-008 | 11 |
| [T-0617](T-0617.md) | INS | US institutions pull USD by ACH, held until the bank's hold date | REQ-INS-009 | 12 |
| [T-0618](T-0618.md) | INS | The bank's incoming credits post deposits by payment reference | REQ-INS-007 | later |
| [T-0619](T-0619.md) | INS | Institution KYB record and decision; two reviewers when high risk | REQ-INS-011 | 12 |
| [T-0620](T-0620.md) | INS | KYB over HTTP under /admin | REQ-INS-011 | 12 |
| [T-0621](T-0621.md) | INS | The KYB gate on deposits, allowances, credit and payouts | REQ-INS-010 | 12 |
| [T-0622](T-0622.md) | INS | KybPort and simulator: registry, exempt status, screening as evidence | REQ-INS-011, REQ-INS-013 | 12 |
| [T-0623](T-0623.md) | PO | Institution payouts only to the verified own-name account | REQ-INS-012 | 12 |
| [T-0624](T-0624.md) | INS | Daily sanctions rescreen and the KYB refresh sweep | REQ-INS-013, REQ-INS-014 | 12 |
| [T-0625](T-0625.md) | INS | Institution payouts are withdrawals to the own account: API fills the payee, console shows it | REQ-INS-012, REQ-PO-001 | 12 |
| [T-0626](T-0626.md) | INS | A student joins from their invite: preview, accept, active once identity-checked | REQ-INS-002 | 13 |
| [T-0627](T-0627.md) | INS | Finance creates an allowance schedule in I07 | REQ-INS-003 | 13 |
| [T-0628](T-0628.md) | PO | An institution payout keeps its requester through a cool-off | REQ-INS-004 | 13 |
| [T-0629](T-0629.md) | INS | Finance bills a fee to the yeshiva's members in I08 | REQ-INS-006 | 13 |
| [T-0630](T-0630.md) | INS | Console: US finance pull from the institution's bank by ACH and see what is on hold | REQ-INS-009 | 12 |
| [T-0631](T-0631.md) | INS | A suspense bank credit is recorded against the right institution from its case | REQ-INS-015 | 12 |
| [T-0632](T-0632.md) | INS | Self-serve application: the entity, its signatories and own-name account, then submit | REQ-INS-016 | 15 |
| [T-0633](T-0633.md) | INS | I01 org onboarding in the console: apply, signatories, account, submit, status | REQ-INS-016 | 15 |
| [T-0634](T-0634.md) | INS | The institution dashboard: active students, onboarding funnel, master balance, upcoming runs | REQ-INS-017 | 15 |
| [T-0635](T-0635.md) | INS | I02 dashboard is the console's landing | REQ-INS-017 | 15 |
| [T-0636](T-0636.md) | INS | Cohorts: create with dates, place members | REQ-INS-018 | 15 |
| [T-0637](T-0637.md) | INS | I03 cohorts in the console | REQ-INS-018 | 15 |
| [T-0638](T-0638.md) | INS | The roster for staff: status, card, balances, plan; filter and page | REQ-INS-019 | 15 |
| [T-0639](T-0639.md) | INS | I04 roster in the console, with bulk actions | REQ-INS-019, REQ-INS-002 | 15 |
| [T-0640](T-0640.md) | INS | I05 import roster in the console: upload, map columns, validation report | REQ-INS-001 | 15 |
| [T-0641](T-0641.md) | INS | One student for staff: status, allowances, fees owed; spend only with live consent | REQ-INS-005, REQ-INS-019 | 15 |
| [T-0642](T-0642.md) | INS | I06 student detail in the console | REQ-INS-005 | 15 |
| [T-0643](T-0643.md) | INS | Team and roles: admins invite staff and change roles; finance and admin need a second approver | REQ-INS-020 | 15 |
| [T-0644](T-0644.md) | INS | I11 team and roles in the console | REQ-INS-020 | 15 |
| [T-0645](T-0645.md) | INS | The master account statement: a month that reconciles, and its export | REQ-INS-021 | 15 |
| [T-0646](T-0646.md) | INS | I10 master account and I12 reports in the console | REQ-INS-021, REQ-INS-006 | 15 |
| [T-0647](T-0647.md) | INS | InstitutionBankingPort: interface, simulator, contract suite, catalogue entry | REQ-INS-022..026 | later |
| [T-0648](T-0648.md) | INS | Crowded adapter for InstitutionBankingPort | REQ-INS-022, REQ-INS-024 | later |
| [T-0649](T-0649.md) | INS | Crowded webhook receiver: raw-body signature, batch split, dedupe, re-read | REQ-INS-025 | later |
| [T-0650](T-0650.md) | INS | US banking for an institution: platform sub-account or own entity, hosted application, status, KYB gate | REQ-INS-022 | later |
| [T-0651](T-0651.md) | INS | US banking screen in the console | REQ-INS-022, REQ-INS-024 | later |
| [T-0652](T-0652.md) | INS | Fees to US funders through the provider's payment page | REQ-INS-023 | later |
| [T-0653](T-0653.md) | INS | Fund the master account by ACH from the linked US account | REQ-INS-024 | later |
| [T-0654](T-0654.md) | INS | Nightly reconciliation of linked US accounts | REQ-INS-026 | later |
| [T-0655](T-0655.md) | INS | Crowded go-live kit: vendor questions, runbook, webhook registration | REQ-INS-025, REQ-INS-026 | later |
| [T-0656](T-0656.md) | INS | Evaluate Crowded ILS transfers as a USD→ILS route (spike) | REQ-FX-001, REQ-FX-003, REQ-PO-001 | later |
| [T-0657](T-0657.md) | INS | Fix: Crowded lookups match on our institution id, not the name | REQ-INS-022, REQ-INS-023 | fix |
| [T-0658](T-0658.md) | INS | Fix: US funding re-checks the kill switch, KYB and account before every send | REQ-INS-024, REQ-INS-022 | fix |
| [T-0659](T-0659.md) | INS | Go-live wiring: Crowded adapter by config, secrets passed, keys persisted | REQ-INS-022, REQ-INS-025 | go-live |
| [T-0660](T-0660.md) | INS | Crowded HTTP simulator and an end-to-end run of the US-banking flows | REQ-INS-022, REQ-INS-023, REQ-INS-024, REQ-INS-025 | go-live |
| [T-0670](T-0670.md) | DSN | Redesign tokens: navy and sky palette with dark-mode parity | REQ-WAL-001 | later |
| [T-0671](T-0671.md) | DSN | Redesign mobile primitives: balance hero, tab bar, badge, list row | REQ-WAL-001 | later |
| [T-0672](T-0672.md) | DSN | Redesign mobile home: hero balance, quick actions, activity list | REQ-WAL-001 | later |
| [T-0673](T-0673.md) | DSN | Redesign mobile navigation: bottom tab bar | REQ-WAL-001 | later |
| [T-0674](T-0674.md) | DSN | Redesign the card screen: card art, frozen state, controls | REQ-CRD-003 | later |
| [T-0675](T-0675.md) | DSN | Redesign console shared styles: tokens, pills, tables, stat tiles | REQ-INS-006 | later |
| [T-0676](T-0676.md) | DSN | Redesign console pages: roster and allowance preview | REQ-INS-003, REQ-INS-004 | later |
| [T-0677](T-0677.md) | DSN | Redesign admin shell: navigation and tiles | REQ-INS-006 | later |
| [T-0678](T-0678.md) | DSN | Hebrew copy and number format audit | REQ-WAL-001 | later |
| [T-0679](T-0679.md) | DSN | Fold the purse cards into the Home hero | REQ-WAL-001 | later |
| [T-0680](T-0680.md) | WAL | Fix: a resolved "unknown load" case reopens when the vendor still does not know the load | REQ-WAL-003, REQ-LED-004 | fix |
| [T-0681](T-0681.md) | WAL | Sweeps report how many times they asked the vendor | REQ-WAL-003 | fix |
| [T-0701](T-0701.md) | MKT | addon_order lifecycle + ledger postings | REQ-MKT-001 | 7 |
| [T-0702](T-0702.md) | MKT | Catalogue sync + price rules | REQ-MKT-002 | 7 |
| [T-0710](T-0710.md) | MKT | Airalo adapter (must pass esimContract) | REQ-ESIM-001 | 7 |
| [T-0711](T-0711.md) | MKT | Entitlement credit at checkout | REQ-ESIM-002 | 7 |
| [T-0712](T-0712.md) | MKT | Usage polling + notifications | REQ-ESIM-003 | 7 |
| [T-0713](T-0713.md) | MKT | Screens M25-M28 | REQ-ESIM-001 | 7 |
| [T-0720](T-0720.md) | MKT | Cover Genius adapter + disclosure checkout | REQ-INSR-001 | 7 |
| [T-0730](T-0730.md) | MKT | Concierge bridge + emergency flow M31-M32 | — | 7 |
| [T-0731](T-0731.md) | MKT | M26 on a phone without eSIM support lists the plans to buy for another device | REQ-ESIM-001 | 13 |
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
| [T-0916](T-0916.md) | ADM | A market's provider row is live only where a vendor is bound | — | 9 |
| [T-0917](T-0917.md) | ADM | The console ships as an image that turns healthy only when configured | REQ-AUTH-009 | 9 |
| [T-0918](T-0918.md) | ADM | A misconfigured console stops at boot and says why | REQ-AUTH-009 | 9 |
| [T-0919](T-0919.md) | ADM | Staff sign in to a local console through a simulator identity provider | REQ-AUTH-009 | 10 |
| [T-0920](T-0920.md) | CMP | Recorded walkthroughs of REC-01 to REC-05, and the recording harness | — | 10 |
| [T-0921](T-0921.md) | CMP | Recorded walkthroughs of REC-06 to REC-09 | — | 10 |
| [T-0922](T-0922.md) | CMP | Recorded walkthroughs of REC-10 to REC-12 | — | 10 |
| [T-0923](T-0923.md) | CMP | Recorded walkthroughs of REC-15 to REC-18; the package links all eighteen | — | 10 |
| [T-0924](T-0924.md) | ADM | Admins onboard institutions and staff; finance and admin roles take a second admin | REQ-ADM-004 | 11 |
| [T-0925](T-0925.md) | ADM | Customer 360 tells the truth: KYC, cards, balances as the member sees them | REQ-ADM-001 | 11 |
| [T-0926](T-0926.md) | ADM | Admin console: an institution's KYB review | REQ-INS-011, REQ-INS-010 | 12 |
| [T-0927](T-0927.md) | CMP | Recordings REC-13 (withdrawal) and REC-14 (allowance run) on the institution console | — | 13 |
| [T-0928](T-0928.md) | ADM | Kesher finance sets add-on price rules, two-person approved (API) | REQ-MKT-002 | 13 |
| [T-0929](T-0929.md) | ADM | A05 price rules in the admin console, and the demo's eSIM rule | REQ-MKT-002 | 13 |
| [T-0930](T-0930.md) | ADM | Ops cases form one queue: filter, assign, resolve or dismiss with a note, audited | REQ-ADM-005 | 12 |
| [T-0931](T-0931.md) | ADM | The admin console's ops queue, and a suspense credit recorded from its case | REQ-ADM-005 | 12 |
| [T-0932](T-0932.md) | ADM | Plan versions: finance proposes, a second approves, only then offered | REQ-ADM-006 | 12 |
| [T-0933](T-0933.md) | ADM | A13 Plans in the admin console, and the demo's plan through it | REQ-ADM-006 | 12 |
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
| [T-1011](T-1011.md) | AGT | A member can read the proposals waiting for them | REQ-AGT-006 | 11 |
| [T-1012](T-1012.md) | AGT | Approve or decline an assistant's proposal in the app | REQ-AGT-006 | 11 |
| [T-1013](T-1013.md) | AGT | Mount the MCP gateway on the API | REQ-AGT-001, REQ-AGT-002, REQ-AGT-006 | 12 |
| [T-1014](T-1014.md) | AGT | Authorization server 1: discovery, JWKS, the authorization request | REQ-AGT-010 | 13 |
| [T-1015](T-1015.md) | AGT | Authorization server 2: passkey consent creates the grant and a one-time code | REQ-AGT-010 | 13 |
| [T-1016](T-1016.md) | AGT | Authorization server 3: token endpoint, PKCE, rotating refresh tokens | REQ-AGT-011 | 13 |
| [T-1017](T-1017.md) | AGT | App consent screen and a demo assistant client | REQ-AGT-010 | 13 |
| [T-1018](T-1018.md) | AGT | Fix: an approved agent purchase is single-use and bound to its merchant | REQ-AGT-006, REQ-CRD-008 | fix |
| [T-0682](T-0682.md) | AUTH | Passkey ceremonies and step-up tokens live in Postgres, not process memory | REQ-AUTH-006, REQ-AUTH-007 | 16 deploy |
| [T-0683](T-0683.md) | LED | A statement source for the partner reconciliation, read from the funding vendor | REQ-LED-004 | 16 deploy |
| [T-0684](T-0684.md) | LED | The nightly job runs partner reconciliation and opens a case for each break before 06:00 IL | REQ-LED-004 | 16 deploy |
| [T-0685](T-0685.md) | LED | A ledger correction is proposed through two-person approval and executes as a reversing journal | REQ-LED-001, REQ-ADM-002 | 16 deploy |
| [T-0686](T-0686.md) | LED | A card-network dispute opens a case, holds the amount and resolves to a reversal or a release | REQ-CRD-008 | 16 deploy |
| [T-0687](T-0687.md) | NOT | The outbox is drained on a schedule, safely across two workers | REQ-NOT-002 | 16 deploy |
| [T-0688](T-0688.md) | NOT | Institutions manage webhook endpoints and ops replays a delivery, behind `webhooks.outbound` | REQ-NOT-002 | 16 deploy |
| [T-0689](T-0689.md) | MON | `provider.error` is emitted for every port and rejected webhooks are counted | — | 16 deploy |
| [T-0690](T-0690.md) | SETUP | A scheduled workflow runs every adapter's contract suite against the vendor sandboxes | — | 16 deploy |
| [T-0691](T-0691.md) | AUTH | Sign in with Apple and Google are offered together, behind a flag | REQ-AUTH-004 | later |
| [T-0692](T-0692.md) | AUTH | Closing an Apple-linked account revokes the Apple token | REQ-AUTH-005 | later |
| [T-0693](T-0693.md) | AUTH | Institution staff are deprovisioned within 15 minutes by a SCIM call | REQ-AUTH-008 | later |
| [T-0694](T-0694.md) | AUTH | A member's Apple or Google link is stored, with the Apple refresh token sealed | REQ-AUTH-004, REQ-AUTH-005 | later |
| [T-0695](T-0695.md) | INS | A Crowded 409 DUPLICATE_REQUEST on an ACH means in flight: retry the same key before calling the outcome unknown | REQ-INS-024 | later |
| [T-0696](T-0696.md) | INS | A sub-account create whose outcome is unknown is looked up by name, not retried | REQ-INS-024 | later |
E04 (card + push provisioning) and E05 (wallet, P2P, FX, payouts) are built against the simulators (ADR-006, 2026-10-17); the processor adapter is a later card once the vendor is signed.
