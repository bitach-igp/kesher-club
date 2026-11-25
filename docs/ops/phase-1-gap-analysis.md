# Phase 1 rollout: gap analysis

Source: the founder's phase 1 voice notes, 2026-11-25 (target segment, street go-to-market, the "What do you want to do today?" screen, the sender workflow, donation classification, eight open questions). Compared with `main` at 0a621d5 on 2026-11-25. Everything below was read from the repository; nothing was run against a vendor, a bank or a device. Cards are T-1101 to T-1114 (above the highest card on `main`, T-1025). **Nothing in them is built.** Card text and the product name: the name is on hold (rabbi's blessing), so no card bakes it in.

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

Buildable without a decision (all flag-gated, nothing live): T-1101, T-1102, T-1104, T-1105 (context optional until T-1106 sets a threshold), T-1109, T-1110, T-1113. T-1103 builds with an empty basis list but must not be turned on before T-1112. After decisions: T-1107, T-1108. Decision cards: T-1106, T-1111, T-1112, T-1114.

Design notes that shape the cards:
- **No funds held for someone without an account.** T-1104 moves no money until the recipient has joined and passed tier 1; this respects the call's point that the platform should not hold customer money (ADR-018).
- **Privacy stays closed.** The 404 for non-members stays the default (nobody can probe who is a member); the invite is an explicit sender action.
- **Statements are untrusted text.** The "Israel connection" and any note are plain text, length-capped, never logged and never in a receipt.
- **The ledger stays insert-only.** Context and profile history are separate append-only tables; no journal is edited.

## Launch checklist (to be owned in T-1114)

Before any member sends real money, as the repository stands today: bank approval for book transfers and wallet (`p2p.enabled`, `wallet.enabled`); a KYC provider bound and a requirement row set; Crowded production sub-account quota, ILS timing in writing and the partnership agreement; counsel's answers (T-0759, T-1106); the deploy-readiness items (T-0058, T-0060, T-0068, T-0069, T-0070); a device test of passkeys, links and push; real-Postgres apply of each migration; the Stripe-versus-Crowded billing flag mismatch resolved (ADR-018, T-0043).

## What this analysis did not check

It did not run any code, vendor sandbox or device. It relied on a read of `main` and the recorded ADR-018 decision log; Crowded's answers dated after 2026-11-19 may exist outside the repository. Hebrew copy for every new screen is unreviewed. The card text is a first draft for the owner to correct before any card is built.
