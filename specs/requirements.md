# Requirements catalogue

Snapshot of Tab 3 §2-3. Full Given/When/Then acceptance lives in the live spec; each REQ's test is the TST id with the same number.

| REQ | Priority | Requirement |
|---|---|---|
| REQ-AUTH-001 | P1 | Register with phone OTP and enrol a passkey |
| REQ-AUTH-002 | P1 | Passkeys are the default sign-in; OTP only for recovery |
| REQ-AUTH-003 | P1 | OTP recovery puts the account in a 24 h restricted state |
| REQ-AUTH-004 | P2 | Sign in with Apple and Google offered together or not at all |
| REQ-AUTH-005 | P2 | Deleting an Apple-linked account revokes the Apple token |
| REQ-AUTH-006 | P1 | Money actions need step-up younger than 5 minutes |
| REQ-AUTH-007 | P1 | 10-min access, rotating refresh, family revocation on reuse |
| REQ-AUTH-008 | P2 | Institution staff SSO with SCIM deprovisioning in 15 min |
| REQ-AUTH-009 | P1 | Admin via SSO + phishing-resistant MFA, VPN only |
| REQ-BIL-001 | P1 | Members see the plan versions offered in their market, with price per term, term and monthly price; never a proposed or rejected one |
| REQ-BIL-002 | P1 | A T1-verified funder invites a member onto a plan with a saved payment method; the invite expires in 7 days and charges nothing until accepted |
| REQ-BIL-003 | P1 | Accepting a funder's invite starts one active membership on the invite's plan version, charged once however often it is retried |
| REQ-BIL-004 | P1 | A funder cancels a membership they pay for in two taps, at the end of the paid period; the member keeps the money loaded |
| REQ-LED-001 | P1 | Every journal sums to zero per currency |
| REQ-LED-002 | P1 | ledger.* rejects UPDATE/DELETE at grant level |
| REQ-LED-003 | P1 | Same idempotency key returns the original journal |
| REQ-LED-004 | P1 | Nightly reconciliation opens a case for any break by 06:00 IL |
| REQ-LED-005 | P1 | A forged webhook never claims a genuine event id; the genuine delivery is processed once |
| REQ-WAL-001 | P2 | USD and ILS purses; available = settled - holds |
| REQ-WAL-002 | P2 | Loads by debit card, Apple Pay, Google Pay; ACH when enabled |
| REQ-WAL-003 | P2 | ACH loads held for the bank's hold days |
| REQ-WAL-004 | P2 | Auto-reload to target, at most once per 24 h |
| REQ-WAL-005 | P1 | Balance withdrawn or refunded on closure |
| REQ-WAL-006 | P2 | Loads credit the chosen purse; cross-currency loads convert at the club rate |
| REQ-WAL-007 | P2 | A funder sees each member they fund and each open invite, with balances and last spend, and no one else's |
| REQ-WAL-008 | P2 | Members see each purse's transactions newest first, with kind, direction, amount, state, time, and a card spend's category and country |
| REQ-WAL-009 | P2 | A funder sees a funded member's transactions and the month's spend by category, never P2P notes or counterparties, and only for members they fund |
| REQ-CRD-001 | P2 | Virtual card within 60 s of T2 approval |
| REQ-CRD-002 | P2 | PAN/CVV only via the processor PCI component |
| REQ-CRD-003 | P2 | JIT decision under 300 ms p99 |
| REQ-CRD-004 | P2 | Freeze applies to next auth and all device tokens |
| REQ-CRD-005 | P2 | Funder controls override member settings |
| REQ-CRD-006 | P2 | In-app push provisioning to Apple/Google wallets |
| REQ-CRD-007 | P2 | Token lifecycle webhooks update card_token within 60 s |
| REQ-CRD-008 | P3 | Parent setting for agent purchases |
| REQ-CRD-009 | P2 | Physical card shipping and in-app activation |
| REQ-PAY-001 | P2 | Send to a verified member via book transfer |
| REQ-PAY-002 | P2 | Enforce the lower of entitlement and risk limits |
| REQ-PAY-003 | P2 | New counterparty over 500 ILS or 150 USD holds 2 h |
| REQ-PAY-004 | P2 | Requests and splits expire in 14 days |
| REQ-PAY-005 | P2 | Retries never create two transfers |
| REQ-PAY-006 | P2 | Send from a chosen purse; recipient credited in their receiving currency at the club rate |
| REQ-PAY-007 | P2 | Receiving currency preference: USD, ILS or as sent |
| REQ-PAY-008 | P2 | Members set the name others see when paying them; only the first name and last initial are kept, sealed |
| REQ-INS-001 | P1 | Roster CSV import, all or nothing |
| REQ-INS-002 | P1 | Invites and onboarding funnel |
| REQ-INS-003 | P2 | Allowance runs with dry run, one workflow per date |
| REQ-INS-004 | P2 | Second finance approver over 5,000 ILS |
| REQ-INS-005 | P1 | No merchant-level spend for staff without consent |
| REQ-INS-006 | P2 | Collections receipts and monthly export |
| REQ-INS-007 | P2 | Recorded institution deposits post once, after a second finance approver |
| REQ-INS-008 | P2 | Allowance runs stop at the institution's two-admin credit limit |
| REQ-INS-009 | P2 | US institutions pull USD by ACH, held until the bank's hold date |
| REQ-INS-010 | P1 | Deposits, allowances, credit and payouts follow the institution's KYB decision |
| REQ-INS-011 | P1 | KYB approval rests on recorded evidence; high risk takes two reviewers |
| REQ-INS-012 | P1 | Institution payouts only to the verified own-name account |
| REQ-INS-013 | P2 | Daily sanctions rescreen; an open match suspends payouts and credit draws |
| REQ-INS-014 | P2 | KYB refresh every 12/24/36 months by risk; overdue drops to approved with limits |
| REQ-INS-015 | P2 | A suspense bank credit is resolved only by recording it against an institution through the two-person deposit path, or dismissed with a note |
| REQ-INS-016 | P1 | An organisation applies on its own: entity, signatories, own-name account; submitting opens KYB review, and no money moves until approved |
| REQ-INS-017 | P2 | Staff see their institution's dashboard: active students, onboarding funnel, master balance, upcoming runs |
| REQ-INS-018 | P2 | Cohorts with start and end dates; members placed in one cohort of their own institution |
| REQ-INS-019 | P2 | Staff list the roster by status and cohort: name, status, card, balances, plan; never merchant-level spend |
| REQ-INS-020 | P2 | Institution admins invite staff and change roles; finance and admin roles need a second approver; removal ends access at once |
| REQ-INS-021 | P2 | A month's master account statement reconciles opening to closing, and its export equals it |
| REQ-FX-001 | P2 | Quotes lock 30 s with rate, markup, total |
| REQ-FX-002 | P2 | Markup from plan config stored on the journal |
| REQ-FX-003 | P2 | Conversions use the club-published, versioned rate; the version is on the quote and the journal |
| REQ-FX-004 | P2 | A rate past its validity is never used; without a valid rate, quotes answer PROVIDER_UNAVAILABLE |
| REQ-PO-001 | P2 | Payee validation and 24 h cooling-off |
| REQ-PO-002 | P2 | Failed payout auto-reverses and notifies |
| REQ-MKT-001 | P1 | addon_order lifecycle posts cost, price, commission |
| REQ-MKT-002 | P1 | Prices from rules, never hard-coded |
| REQ-ESIM-001 | P1 | Buy, one-tap install, usage |
| REQ-ESIM-002 | P1 | Monthly data credit applies at checkout |
| REQ-ESIM-003 | P1 | Low-data and expiry notifications |
| REQ-INSR-001 | P1 | Insurance checkout disclosures before payment |
| REQ-AGT-001 | P3 | /mcp publishes Protected Resource Metadata |
| REQ-AGT-002 | P3 | Audience-bound tokens |
| REQ-AGT-003 | P3 | CIMD registration with SSRF guard |
| REQ-AGT-004 | P3 | No user-token passthrough |
| REQ-AGT-005 | P3 | Scope tiers with insufficient_scope step-up |
| REQ-AGT-006 | P3 | Money tools only create pending intents |
| REQ-AGT-007 | P3 | Untrusted text never treated as instructions |
| REQ-AGT-008 | P3 | Visible grants, one-tap revoke in 60 s |
| REQ-AGT-009 | P3 | 60 calls/min per grant, audited |
| REQ-AGT-010 | P3 | Assistants get a grant only through OAuth code + PKCE and the member's passkey consent |
| REQ-AGT-011 | P3 | 10-minute access tokens; rotating refresh tokens, and a replayed one revokes the grant |
| REQ-NOT-001 | P1 | Channel preferences and quiet hours |
| REQ-NOT-002 | P1 | Standard Webhooks outbound with retries |
| REQ-ADM-001 | P1 | Hash-chained admin audit |
| REQ-ADM-002 | P1 | Two-person money flag flips |
| REQ-ADM-003 | P2 | Finance publishes club rates through the admin API; manual rates need two finance approvers and an audit entry |
| REQ-ADM-004 | P2 | Admins onboard institutions and their staff; institution finance and admin roles need a second admin and an audit entry |
| REQ-ADM-005 | P2 | Ops cases (all but the compliance alerts) form one queue: filter, assign, resolve or dismiss with a note, audited; support reads only |
| REQ-ADM-006 | P2 | Plan versions are offered only after a second finance approver; never edited, only superseded |
| REQ-CMP-001 | P2 | Monitoring alerts with dispositions |
| REQ-CMP-002 | P1 | Complaint SLA timers and export |
