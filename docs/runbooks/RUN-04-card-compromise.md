# RUN-04 Card compromise
Owner: support lead, with the on-call engineer · Severity: SEV2 (SEV1 if many cards) · Last tested: never
Alert: processor fraud alert, a monitoring case of kind `velocity` on card spend, or a member report through the help line
Related: REQ-CRD-004, REQ-CRD-005, REQ-CMP-001; flags `card.virtual`, `card.physical`, `card.pushProvisioning`; port `CardIssuingPort`

## First five minutes
1. Freeze the card and its tokens: the member can from M20, support can through Customer 360 (`getAdminCustomer`, then the freeze action), and the freeze cascades to every device token (REQ-CRD-004). The next authorisation is declined.
2. If a pattern is visible (one MCC, one country), block it on the card's controls rather than waiting for the reissue.
3. Confirm the scope with the processor: one card, a BIN range, or a merchant breach? A range is SEV1.
4. Tell `#incidents` and the bank contact; a breach has reporting duties under the program agreement.

## Resolution path
- Reissue the card through the processor; the new card is a new `cards.card` row, the old one `closed`.
- Disputes follow Reg E timelines: provisional credit within 10 business days on a consumer claim, investigation within 45 days. Each disputed transaction is a case with the processor's dispute id in `ops.external_ref`.
- A provisional credit is a journal from `suspense` to the member's purse with two-person approval; its reversal, if the dispute fails, is the reversing journal.
- A monitoring case stays open until compliance records its disposition.

## Member message
"We froze your card to protect you after unusual activity. Your money is safe. A new card is on its way; tap Help if you need to pay now." · Channel: push, then email

## Verify it is over
- No authorisation attempts on the frozen card for 24 hours; the new card active and provisioned.
- Every disputed transaction has a case and a provider dispute id.
- Post-incident note within 2 business days for any SEV1.
