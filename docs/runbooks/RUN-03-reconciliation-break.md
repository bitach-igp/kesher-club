# RUN-03 Reconciliation break
Owner: finance on-call, with the on-call engineer · Severity: SEV2 (SEV1 if a member's balance is wrong) · Last tested: never
Alert: `recon_break` (a break over $50, or any break aged over 24 h); `balance_proof_failed` (the nightly proof found a cached balance that does not equal its postings, or system totals off zero)
Related: REQ-LED-001, REQ-LED-004; flags `payouts.nium`, `wallet.enabled`; ports `FundingPort`, `PayoutPort`, `CardIssuingPort`

## First five minutes
1. Open the case: `/admin/alerts` lists it (kind `recon_break`); the `ops.recon_break` row names the provider, the external id, the journal if any, both amounts and the reason (`missing_journal`, `missing_partner`, `amount_mismatch`, `currency_mismatch`).
2. Freeze the payout queue for the affected accounts: in the admin console set the `PayoutPort` binding to `degraded` if the break is on payouts, otherwise leave payouts alone. Nothing else moves money on its own.
3. Pull the processor or partner record for the external id and put it on the case.
4. If the break is a `balance_break` from the proof, stop here and page the engineer: a cached balance that disagrees with its postings is a code problem, not a provider one.

## Resolution path
- Ours or theirs? A `missing_partner` break with a settled journal means we posted something the provider never did: find the transfer, check its webhook history in `ops.inbound_event`, and expect the provider's late record before correcting.
- A correction is a reversing journal through the approvals service (`ledger_correction`, two approvers, a reason that names the case). Never edit `ledger.*` rows; the role cannot.
- A provider dispute goes through the provider's process with the case id as the reference.
- A `balance_break`: do not touch the cache in production. The fix is in code; the cache is rebuilt only by RUN-08's restore path (`rebuildBalanceCache` under `club_migrator`, money flags off).
- Close the case with the disposition and the journal id of the correction.

## Member message
None unless a member's balance changed. If it did: "We corrected a {amount} entry on your account on {date}. Nothing is needed from you." · Channel: email

## Verify it is over
- The next nightly reconciliation shows zero breaks for the provider; the balance proof passes.
- The case is resolved in the console with the correcting journal linked.
- Post-incident note within 2 business days if a member's balance changed.
