# Phase 1 rollout: gap analysis

Source: the founder's phase 1 voice notes, 2026-11-25 (target segment, street go-to-market, the "What do you want to do today?" screen, the sender workflow, donation classification, eight open questions). Compared with `main` at 0a621d5 on 2026-11-25. Everything below was read from the repository; nothing was run against a vendor, a bank or a device. Cards are T-1101 to T-1115 (above the highest card on `main`, T-1025). **Nothing in them is built.** Card text and the product name: the name is on hold (rabbi's blessing), so no card bakes it in.

## Summary

The platform is a simulator-built wallet, P2P, card, eSIM and insurance product aimed at members, funders and institutions. The founder's phase 1 is different in one way that matters: a **person-to-person gift to a qualifying person in Israel, treated as a donation through a nonprofit**. The code has the money rails for a transfer (wallet send, FX, payouts, limits, idempotency) but none of the *who is this person* layer, none of the *organization in the middle* layer, no donation or receipt layer, no referral layer, and no way to pay a person who has no account yet.

Nearly every money flag is off in production, no KYC, card or payout vendor is bound, and the Crowded rails are USD only today. So phase 1 is gated by decisions and approvals as much as by code.

## Gap table

| # | Founder need | Today on `main` | Status | Card |
|---|---|---|---|---|
| 1 | Segments: students, rabbis, seminary, soldiers, volunteers, programs | Roles member, funder, institution staff; institutions and cohorts. No category, program or lone-soldier concept anywhere. | Absent | T-1101, T-1102 |
| 2 | Street, referral-driven distribution | No referral code, attribution or ambassador. Invites are tokens (funder, roster) with no attribution. | Absent | T-1110 (attribution only), T-1111 (decision) |
| 3 | "What do you want to do today?" screen | Home is a dashboard with quick actions; the Club hub shows eSIM, insurance, concierge. No such screen; AI exists only as an external-assistant (MCP) flow. | Absent | T-1113 |
| 4a | Send to a person in Israel | Built on simulators: wallet to wallet book transfer, limits, new-pair hold, USD to ILS at the club rate. `p2p.enabled` and `wallet.enabled` off. | Built (sim) | none |
| 4b | The recipient must exist | The recipient must already be a verified member (found by phone or member id). A non-member answers an indistinguishable 404. No invite-to-receive, no pending claim. | Absent | T-1104 |
| 4c | Name, kind of person, Israel connection, qualification stored | Only the recipient's display name (sealed). No relationship, purpose or connection field, no qualification record, no review workflow. | Absent | T-1101, T-1103, T-1105 |
| 5 | Donation classification and receipts | No code, flag, REQ or ledger concept. Documented only as questions (Crowded README 7, ADR-018 A5, T-0758, T-0759). Collections receipts cover institution fees only. | Absent | T-1106 (decision), T-1108 |
| 6 | Organization in the middle: sender, organization, recipient | ADR-018 decided option 2 (member sub-accounts under Zuz's nonprofit, "at least for now"). Port, adapter, quota guard, flag `wallet.subAccounts` built on fakes, turn-on needs counsel (T-0759). The sender, organization, recipient chain is not modelled in the ledger. | Decided in principle, partly built, blocked | T-1106, T-1107 |
| 7 | Receive money | Requests and splits exist (14-day expiry) but the payer must be a member; no link, no way to ask a non-member. | Partial | T-1109 |
| 8 | KYC and onboarding by category, minors, Israeli ID | Two KYC tiers on a simulator; no provider bound; no requirement row; no Teudat Zehut, IDF ID or per-category model; no date of birth stored; minors unresolved (T-0738 I4). | Absent / open | T-1112 |
| 9 | Which products ship in phase 1 | Flags mostly off; see the launch checklist. | Open | T-1114 |

## Walk-through: a parent sends a soldier $500 (as the code stands)

1. The parent registers (phone OTP and passkey) and passes tier 1 KYC (simulator).
2. The parent loads USD (Stripe or hosted Crowded, both flag-gated and blocked for production).
3. The soldier has to register and pass tier 1 first. If not, the send cannot happen (gap 4b).
4. The parent picks Send, types the soldier's phone, $500. No question about who the soldier is or why they qualify (gap 4c).
5. The soldier is credited in USD or ILS. Nothing passes through an organization, nothing is classed as a donation and no receipt exists (gaps 5, 6).
6. Getting ILS to a bank account is a member payout: simulator only, no mobile screen.

## The founder's eight open questions, mapped

| Founder question | Where it stands | Card |
|---|---|---|
| Which organization is the intermediary and who is the legal entity? | ADR-018 chose a nonprofit sub-account structure for now; the entity and the friends-organization question are open with Crowded and counsel. | T-1106 |
| Tax and receipt treatment (US and Israel) | Open; counsel brief T-0759 exists, no answer. | T-1106, T-1108 |
| How is qualification verified, what documents? | Not defined; nothing stores a document and the KYC provider is unbound. | T-1112, T-1103 |
| No category fits: block or ordinary transfer? | Not decided; the profile allows `other`. | T-1106 |
| How does receive work and how does a recipient start a request? | Member-to-member requests only. | T-1109 |
| How do phase 1 flows relate to wallet, card, eSIM, insurance? | Flags mostly off; every one has a gate. | T-1114 |
| Referral and ambassador compensation and compliance | Nothing exists; compensation is a legal question. | T-1111 |
| KYC and onboarding for each category, soldiers and minors | Open; minors unresolved. | T-1112 |

## Safe to start now versus waiting

Buildable without a decision (all flag-gated, nothing live): T-1101, T-1102, T-1104, T-1105 (context optional until T-1106 sets a threshold), T-1109, T-1110, T-1113. T-1103 builds with an empty basis list but must not be turned on before T-1112. After decisions: T-1107, T-1108. Decision cards: T-1106, T-1111, T-1112, T-1114; a person puts the sixteen new questions to Crowded in T-1115.

Design notes that shape the cards:
- **No funds held for someone without an account.** T-1104 moves no money until the recipient has joined and passed tier 1; this respects the call's point that the platform should not hold customer money (ADR-018).
- **Privacy stays closed.** The 404 for non-members stays the default (nobody can probe who is a member); the invite is an explicit sender action.
- **Statements are untrusted text.** The "Israel connection" and any note are plain text, length-capped, never logged and never in a receipt.
- **The ledger stays insert-only.** Context and profile history are separate append-only tables; no journal is edited.

## Launch checklist (to be owned in T-1114)

Before any member sends real money, as the repository stands today: bank approval for book transfers and wallet (`p2p.enabled`, `wallet.enabled`); a KYC provider bound and a requirement row set; Crowded production sub-account quota, ILS timing in writing and the partnership agreement; counsel's answers (T-0759, T-1106); the deploy-readiness items (T-0058, T-0060, T-0068, T-0069, T-0070); a device test of passkeys, links and push; real-Postgres apply of each migration; the Stripe-versus-Crowded billing flag mismatch resolved (ADR-018, T-0043).

## Cross-reference with the Crowded documents (2026-11-25)

Read from the four Crowded documents in `docs/vendors/crowded` (inventory read 2026-11-03, two Postman exports, README with its question log) and ADR-018. No Crowded tool or network call was made; Crowded answers given after 2026-11-19 may exist outside the repository.

| Phase 1 need | Crowded today | Where it is asked |
|---|---|---|
| A. Gift credited to a named person as a donation | **Partial, mostly undocumented.** A sub-account is a chapter with its own deposit account and takes collections and intents. The credit from the nonprofit to one child was described only on a call. `subaccounts/fund` has no documented amount unit or response, and a book payment cannot cross chapters. | Q45, Q51, Q58, Q60 to Q64; new N4, N5 |
| B. Recipient spends or pays out | **USD yes, ILS no.** USD wallet and per-diem accounts and Visa cards exist; no spend controls, no PIN or activation; physical cards ship to US addresses. No IBAN, SWIFT or ILS route in the sandbox; ILS timing is only a verbal "about four weeks". | Q6, Q43, Q44, Q55, Q59; new N9 |
| C. Receipts (US 501(c)(3), 990, Israel) | **Not in the API.** The inventory says no statements, tax forms, receipts or document download. Who issues donor receipts is unanswered. Israeli Section 46 receipts appear nowhere. | Q7 (unanswered), Q62; new N1 to N3 |
| D. Recipient with no account | **Partial.** A sub-account owner can be invited by email and self-onboards, but as a treasurer with full access. A hosted payment needs a contact with a mobile number (a missing one becomes a placeholder that cannot receive SMS). Crowded banks entities only. | Q54, Q56, Q63; new N6, N10 |
| E. Request money, links, recurring gifts | **Supported but gated.** A collection plus an intent gives a per-payer hosted page by card or ACH; donations can be open-amount and recurring. No invoice object; Apple Pay and Google Pay undocumented; fund holding off in the sandbox. | Q18, Q29, Q30, Q36, Q38, Q51, Q65 to Q72; new N10, N16 |
| F. KYC by category, minors | **Undocumented.** "Light KYC" is stated only for per-diem cardholders. Owner KYC, minors and Israeli IDs are not stated. | Q8, Q31, Q52, Q53, Q56, Q58; new N7, N8 |
| G. Fees, FX, rails | **Partial.** ACH, same-day ACH and wire fees are listed; no FX markup from Crowded; production pricing, who pays the hosted-page fee, and ILS timing are not written. | Q5, Q6, Q50; new N14 |
| H. Webhooks and reconciliation | **Supported for USD.** Signed, batched, retried about 48 hours, de-duplicated by event id. Gaps: gross versus net amounts, no refund-completed event, collection payments cannot be simulated in the sandbox, events are per chapter. | Q10, Q13, Q15, Q37 |
| I. Categories, tags, referral, campaigns | **Unsupported.** There is no campaign feature: the word appears four times in the Postman exports, only as prose ("a specific payment request or fundraising campaign", "fundraising campaigns, open-ended giving" for an open-amount collection). There is a "Fundraising" request type and a display-only `goalAmount`, but no public campaign page, peer-to-peer, team, referral or ambassador object. Tags exist only as a read-only field on a transaction. Contacts and payments carry no metadata. | none; new N11, N12, N13 |

**What this changes.** Category, program, the Israel-connection text and referral attribution stay in our own database; Crowded can hold none of it. The sender, organization, recipient chain cannot be built from documented Crowded calls yet, so T-1107 models it in our ledger first. No Crowded receipt adapter should be written until N1 is answered. The appended corrections on each card record the specific changes.

**Conflicts inside the documents** (the owner should know before relying on any one of them):
1. The README header calls Crowded optional and phase 2; ADR-018 (2026-11-18) makes it the phase 1 member rail, and README questions 29 to 48 still assume wallets inside our own chapter.
2. ADR-018 says the donation credited to a child brings a tax benefit; no Crowded document describes a receipt.
3. ADR-018 and the README say fees come from a customer's direct-debit authorization; the inventory says there is no ACH debit or authorization object.
4. "Entities only" (2026-11-16 call) versus "light KYC for per-diem individuals" (answers log 8).
5. The README says a non-money-transmitter model works only if customers fund from their own accounts, which a parent paying into a child's sub-account may not satisfy.
6. The inventory (79 operations, read 2026-11-03) is stale: the sandbox shows 17 more routes, and the two Postman exports are not supersets of each other.
7. ADR-018 cites question 58 for the nonprofit being a full customer; question 60 is the one that asks it.

### New questions for Crowded (N1 to N16, in a card for a person to send: T-1115)

1. Do donations paid on a hosted page to the nonprofit chapter produce a donor receipt? What fields does it carry, and is there an API to fetch, resend or void it, and to read a 990 or donor summary?
2. Can the receipt name the donor (a US parent) while the gift is earmarked for a named beneficiary, and does the nonprofit keep the control language a 501(c)(3) needs?
3. Do Crowded's two 501(c)(3)s, or ours, have Israeli Section 46 status or any Israeli receipt path?
4. Can a collection payment carry a payer-supplied memo or beneficiary reference so the credit to person X is machine-attributable, and which webhook field returns it?
5. What are the unit, minimum and response of `subaccounts/fund`? Is it atomic and idempotent, and which event confirms it?
6. Can an owner be invited by email with KYC finished later while earlier funding sits at the nonprofit? What happens to the funds if the invitee never completes, and does the invitation expire?
7. Which IDs does owner KYC accept (Teudat Zehut, Israeli passport, IDF ID), may a minor own a sub-account or must a guardian, and what is the minimum age?
8. Is a sub-account owner (a treasurer with full access) limited to exempt purposes, or can they move money to any account?
9. Can a sub-account hold ILS and be paid out to a personal Israeli account through the partner token? What is the payout API, quote lock and settlement event?
10. Is there a payment-request link a non-member can open without a contact, and is a hosted `paymentUrl` valid before a contact exists?
11. Can transaction tags be written by API, and are contact tags or segments available, so a partner-set label (a category, a referral code) can ride on a contact or sub-account?
12. Does Crowded have peer-to-peer or campaign pages (teams, goal pages, donor wall) behind the partner token?
13. Does Crowded's approval cover a referral or ambassador compensation model?
14. What is the production hosted-page fee for ACH and card donations, and can the donor pay it?
15. What are the production API base URL and the token issuance process (README Q9, still unanswered)?
16. Are donor-initiated recurring gifts to the nonprofit chapter supported on the hosted page, and can each gift be credited to a different named beneficiary?

## What this analysis did not check

It did not run any code, vendor sandbox or device, and it made no Crowded call, including its MCP tools. The Crowded part rests on the four documents in the repository, which are stale in places (see the conflicts); Crowded's answers dated after 2026-11-19 may exist outside it. Hebrew copy for every new screen is unreviewed. The card text is a first draft for the owner to correct before any card is built.
