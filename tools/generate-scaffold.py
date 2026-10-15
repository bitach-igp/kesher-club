#!/usr/bin/env python3
"""Generates task cards, ADR stubs and the flag registry from the spec (Tab 3 §1, §4, §12).
Re-run after editing the tables below; generated files are committed."""
import json, pathlib

ROOT = pathlib.Path(__file__).resolve().parents[1]

TASKS = [
 # id, epic, parallel, title, reqs, sprint, files
 ("T-0001","SETUP",False,"Monorepo scaffold (pnpm, Turborepo, TS strict, ESLint incl. money-number ban)","",1,"package.json, turbo.json, eslint.config.js"),
 ("T-0002","SETUP",True,"CI workflow: lint, typecheck, unit, Spectral, Semgrep, tfsec, audit","",1,".github/workflows/ci.yml"),
 ("T-0003","SETUP",True,"Terraform base: accounts, VPC, RDS, ECS, KMS, Secrets","",1,"infra/terraform/**"),
 ("T-0004","SETUP",False,"Config loader with Zod, crash on missing secrets","",1,"packages/domain/src/config.ts"),
 ("T-0005","SETUP",False,"Migration tooling (Atlas) + DB roles club_app, club_migrator","",1,"db/**"),
 ("T-0006","SETUP",True,"Tokens package + Style Dictionary outputs","",1,"packages/tokens/**"),
 ("T-0007","SETUP",True,"OpenAPI skeleton + SDK generation + Schemathesis job","",1,"contracts/openapi.yaml, packages/sdk/**"),
 ("T-0008","SETUP",False,"Port interfaces for all 18 ports + empty contract suites","",1,"packages/ports/src/**"),
 ("T-0009","SETUP",False,"Simulator host + control panel; first simulator: Billing","",1,"apps/simulators/**"),
 ("T-0010","SETUP",False,"Preview environments per PR","",1,"infra/preview/**, .github/workflows/preview.yml"),
 ("T-0110","AUTH",False,"OTP start/verify + passkey register","REQ-AUTH-001",1,"apps/api/src/auth/**"),
 ("T-0111","AUTH",False,"Passkey authenticate + device binding","REQ-AUTH-002",2,"apps/api/src/auth/**"),
 ("T-0112","AUTH",False,"Token service: 10-min access, rotating refresh, family revocation","REQ-AUTH-007",2,"apps/api/src/auth/tokens.ts"),
 ("T-0113","AUTH",True,"Mobile sign-in screens M03-M04 with Expo passkeys","REQ-AUTH-001, REQ-AUTH-002",2,"apps/mobile/app/(auth)/**"),
 ("T-0114","AUTH",False,"Recovery restriction state + device notifications","REQ-AUTH-003",2,"apps/api/src/auth/recovery.ts"),
 ("T-0115","AUTH",False,"Step-up endpoint + StepUp component","REQ-AUTH-006",2,"apps/api/src/auth/step-up.ts, packages/ui/src/StepUp.tsx"),
 ("T-0116","AUTH",True,"Admin SSO + VPN-only middleware","REQ-AUTH-009",2,"apps/admin/**"),
 ("T-0117","AUTH",False,"FederatedIdPPort simulator + Apple/Google adapters","REQ-AUTH-004, REQ-AUTH-005",2,"packages/ports/src/federated-idp.*, packages/adapters/apple, packages/adapters/google"),
 ("T-0118","AUTH",False,"OrgIdPPort simulator + vendor adapter per ADR-004","REQ-AUTH-008",2,"packages/ports/src/org-idp.*"),
 ("T-0201","LED",True,"Ledger core post() + invariant trigger (port the reference Ledger to Postgres)","REQ-LED-001, REQ-LED-002",4,"db/migrations/ledger/0001_init.sql, apps/api/src/ledger/post.ts"),
 ("T-0202","LED",True,"Account provisioning per party and currency","REQ-WAL-001",4,"apps/api/src/ledger/accounts.ts"),
 ("T-0203","LED",False,"Balance materialisation + nightly proof","",4,"apps/worker/src/ledger/balance-proof.ts"),
 ("T-0204","LED",False,"Inbound webhook store, verify, dedupe, replay","REQ-LED-003",4,"apps/api/src/webhooks/**"),
 ("T-0205","LED",False,"Transfer state machine + outbox publisher","",4,"apps/api/src/transfers/**"),
 ("T-0206","LED",False,"Reconciliation job + ops cases","REQ-LED-004",4,"apps/worker/src/recon/**"),
 ("T-0301","BIL",False,"Stripe adapter incl. Apple/Google Pay","",3,"packages/adapters/stripe/**"),
 ("T-0302","BIL",False,"Plans, versions, entitlement templates, can() + /me/capabilities","",3,"apps/api/src/billing/**"),
 ("T-0303","BIL",False,"Dunning, pause/resume, 10-month term","",3,"apps/worker/src/billing/**"),
 ("T-0304","BIL",True,"Legal CMS: versions, consent, re-accept","",3,"apps/api/src/legal/**"),
 ("T-0601","INS",False,"Roster import all-or-nothing","REQ-INS-001",2,"apps/api/src/institutions/roster.ts"),
 ("T-0602","INS",False,"Invite fan-out + funnel","REQ-INS-002",2,"apps/api/src/institutions/invites.ts"),
 ("T-0603","INS",False,"RLS + consent grant","REQ-INS-005",8,"db/migrations/org/**"),
 ("T-0604","INS",False,"Allowance schedules + dry run + workflow","REQ-INS-003",8,"apps/worker/src/allowance/**"),
 ("T-0605","INS",False,"Two-person approval service","REQ-INS-004, REQ-ADM-002",8,"apps/api/src/approvals/**"),
 ("T-0701","MKT",False,"addon_order lifecycle + ledger postings","REQ-MKT-001",7,"apps/api/src/addons/**"),
 ("T-0702","MKT",False,"Catalogue sync + price rules","REQ-MKT-002",7,"apps/worker/src/catalogue/**"),
 ("T-0710","MKT",False,"Airalo adapter (must pass esimContract)","REQ-ESIM-001",7,"packages/adapters/airalo/**"),
 ("T-0711","MKT",False,"Entitlement credit at checkout","REQ-ESIM-002",7,"apps/api/src/addons/credit.ts"),
 ("T-0712","MKT",True,"Usage polling + notifications","REQ-ESIM-003",7,"apps/worker/src/esim/**"),
 ("T-0713","MKT",True,"Screens M25-M28","REQ-ESIM-001",7,"apps/mobile/app/club/**"),
 ("T-0720","MKT",False,"Cover Genius adapter + disclosure checkout","REQ-INSR-001",7,"packages/adapters/cover-genius/**"),
 ("T-0730","MKT",False,"Concierge bridge + emergency flow M31-M32","",7,"packages/adapters/concierge/**, apps/mobile/app/help/**"),
 ("T-0801","NOT",False,"NotifyPort with preferences + quiet hours","REQ-NOT-001",6,"packages/ports/src/notify.*"),
 ("T-0802","NOT",True,"Expo push + Postmark + Twilio adapters","",6,"packages/adapters/{expo-push,postmark,twilio}/**"),
 ("T-0803","NOT",False,"Standard Webhooks outbound + replay UI","REQ-NOT-002",8,"apps/api/src/events/**"),
 ("T-0901","ADM",False,"Admin shell, Customer 360","",2,"apps/admin/**"),
 ("T-0902","ADM",False,"Providers & Flags screen with release gates","",2,"apps/admin/app/providers/**"),
 ("T-0903","ADM",False,"Hash-chained audit + verification","REQ-ADM-001",9,"apps/api/src/audit/**"),
 ("T-0904","ADM",True,"Compliance alerts + complaint SLAs","REQ-CMP-002",9,"apps/admin/app/compliance/**"),
 ("T-0905","ADM",False,"Two-person flag flip","REQ-ADM-002",9,"apps/api/src/flags/**"),
 ("T-1001","AGT",False,"Protected Resource Metadata + 401","REQ-AGT-001",10,"apps/api/src/mcp/**"),
 ("T-1002","AGT",False,"Token validation: audience, scopes, grant","REQ-AGT-002, REQ-AGT-005",10,"apps/api/src/mcp/auth.ts"),
 ("T-1003","AGT",False,"CIMD registration with SSRF guard","REQ-AGT-003",10,"apps/api/src/mcp/cimd.ts"),
 ("T-1004","AGT",False,"T0 tools from OpenAPI + untrusted wrapping","REQ-AGT-007",10,"apps/api/src/mcp/tools/**"),
 ("T-1005","AGT",False,"Pending-intent service + approval","REQ-AGT-006",10,"apps/api/src/intents/**"),
 ("T-1006","AGT",False,"Grants screen, revoke, rate limits","REQ-AGT-008, REQ-AGT-009",10,"apps/mobile/app/settings/assistants/**"),
]

ADRS = [
 ("001","Modular monolith vs services","Modular monolith, NestJS","Sprint 1"),
 ("002","Workflow engine","Temporal Cloud","Sprint 1"),
 ("003","Ledger engine","Postgres tables now; TigerBeetle if over 1k TPS","Sprint 4"),
 ("004","Auth vendor for social/org SSO and MCP AS","WorkOS vs Clerk","Sprint 2"),
 ("005","Feature flag system","OpenFeature + Postgres provider","Sprint 2"),
 ("006","Card processor + sponsor bank","Decide from Money20/20 term sheets","Dec 2026"),
 ("007","ILS handling","Native ILS purse if processor supports it, else shadow sub-balance","With ADR-006"),
 ("008","Outbound webhooks","Svix vs in-house Standard Webhooks","Sprint 8"),
 ("009","MCP authorization server","Same AS as ADR-004, separate audience","Before mcp.enabled"),
 ("010","Mobile UI kit","Tamagui vs NativeWind","Sprint 1"),
 ("011","Data residency for Israeli members","US region until a regulator requires Israel","Before Phase 3"),
]

FLAGS = [
 ("auth.passkey.primary",True,"Zvi","Passkey as main credential",""),
 ("auth.social.enabled",False,"Zvi","Sign in with Apple + Google (both or neither)","ADR-004 accepted; SIWA key rotation job live"),
 ("auth.orgSso",False,"Zvi","Institution SAML/OIDC + SCIM","First institution asks; vendor contract"),
 ("billing.stripe",True,"Ezra","Subscriptions","Stripe live keys"),
 ("billing.applePay",True,"Ezra","Apple Pay in Payment Element","Domain verified with Stripe"),
 ("billing.googlePay",True,"Ezra","Google Pay in Payment Element","Domain verified with Stripe"),
 ("esim.airalo",False,"Kathleen","eSIM purchase","Airalo agreement + sandbox certification"),
 ("esim.holafly",False,"Kathleen","Unlimited eSIM SKU","Holafly agreement"),
 ("insurance.coverGenius",False,"Kathleen","Supplemental cover","Distribution agreement + disclosures approved"),
 ("concierge.partner",False,"Kathleen","Partner case bridge","SLA signed"),
 ("wallet.enabled",False,"Ezra","Wallet, balances, loads","Program agreement + bank approval"),
 ("card.virtual",False,"Ezra","Virtual card","Bank approval"),
 ("card.physical",False,"Ezra","Physical card ordering","Card art approved by network"),
 ("card.pushProvisioning",False,"Zvi","Add to Apple Wallet / Google Pay","Processor entitlements + Apple Lab certification"),
 ("card.webPushProvisioning",False,"Zvi","Add to wallet from web","Processor WPP enabled"),
 ("card.agentic",False,"Noah","Agent-initiated purchases","Processor agentic tokens + parent controls UI"),
 ("card.paymentPasskey",False,"Zvi","Network payment passkeys for 3DS","Processor enrolment API for our BIN"),
 ("p2p.enabled",False,"Ezra","Member transfers","Bank approves book transfers"),
 ("fx.enabled",False,"Ezra","USD/ILS conversion","ILS purse or Nium FX live"),
 ("payouts.nium",False,"Ezra","ILS payouts","Nium contract + KYB"),
 ("institutions.money",False,"Ezra","Master accounts, allowances, collections","wallet.enabled + institution agreement"),
 ("funding.ach",False,"Ezra","ACH loads via Plaid","Bank hold policy; Plaid contract"),
 ("funding.rtp",False,"Ezra","RTP/FedNow loads","Sponsor bank confirms rail"),
 ("mcp.enabled",False,"Zvi","Remote MCP, read-only","Pentest of /mcp passed"),
 ("mcp.write.enabled",False,"Zvi","Tier 1 MCP tools","60 days read-only, no incidents"),
 ("mcp.money.propose",False,"Noah","Tier 2 propose-only money tools","Bank sign-off on agent intent flow"),
 ("notify.whatsapp",False,"Kathleen","WhatsApp utility templates","Meta verification + templates approved"),
 ("wallet.pass",False,"Kathleen","Club pass in Wallet","Pass Type ID cert"),
 ("webhooks.outbound",False,"Zvi","Standard Webhooks to institutions","First integrating institution"),
 ("kyc.mdl",False,"Noah","mDL / Digital Credentials KYC","KYC vendor + bank accept mDL for CIP"),
 ("il.payinit",False,"Noah","Israeli pay-by-bank","Licensed PISP partner; directive final"),
 ("us.openbanking1033",False,"Noah","1033 data access","Compliance dates reinstated"),
 ("bit.interop",False,"Noah","Bit/PayBox interoperability","Public interop API exists"),
 ("ui.hebrew",True,"Kathleen","Hebrew locale",""),
]

def main():
    tdir = ROOT/"specs/tasks"; tdir.mkdir(parents=True, exist_ok=True)
    by_epic = {}
    for tid, epic, par, title, reqs, sprint, files in TASKS:
        by_epic.setdefault(epic, []).append(tid)
        tag = " [P]" if par else ""
        reqline = reqs or "— (enabling task)"
        tests = ", ".join(r.replace("REQ-","TST-") for r in reqs.split(", ")) if reqs else "Unit tests for the new module"
        (tdir/f"{tid}.md").write_text(
f"""# {tid}{tag} [{epic}] {title}
REQ: {reqline} · Sprint: {sprint}
Files: {files}
Test first: {tests}
Done when: listed tests pass; `pnpm typecheck`, `pnpm test`, `pnpm trace` green; only listed files touched
Out of scope: anything not named above. Stop and ask on conflict with the spec.
""")
    index = ["# Task index", "", "| Task | Epic | Title | REQ | Sprint |", "|---|---|---|---|---|"]
    for tid, epic, par, title, reqs, sprint, files in TASKS:
        index.append(f"| [{tid}]({tid}.md) | {epic} | {title} | {reqs or '—'} | {sprint} |")
    index += ["", "E04 (card + push provisioning) and E05 (P2P, FX, payouts) are generated once ADR-006 picks the processor."]
    (tdir/"README.md").write_text("\n".join(index)+"\n")

    adir = ROOT/"docs/adr"; adir.mkdir(parents=True, exist_ok=True)
    for n, title, proposed, by in ADRS:
        (adir/f"ADR-{n}.md").write_text(
f"""# ADR-{n}: {title}

Status: Proposed · Decide by: {by}

## Context
See the live spec, Tab 3 §4.

## Options
- {proposed}

## Decision
_Pending._

## Consequences
_Fill in when decided._
""")

    cdir = ROOT/"config"; cdir.mkdir(exist_ok=True)
    (cdir/"flags.json").write_text(json.dumps(
        [{"key":k,"defaultProd":d,"owner":o,"gates":g,"turnOnTrigger":t} for k,d,o,g,t in FLAGS], indent=2)+"\n")
    print(f"{len(TASKS)} tasks, {len(ADRS)} ADRs, {len(FLAGS)} flags")

if __name__ == "__main__":
    main()
