# RUN-09 US banking provider
Owner: on-call engineer, with finance on-call · Severity: SEV2 (SEV1 if a collected payment is lost or an ACH moves money twice) · Last tested: never
Alert: `port_contract_check_failed` or `port_error_rate` on `InstitutionBankingPort` (over 5% for 5 minutes); `webhook_signature_failures` for `crowded` (over 5 in 10 minutes); an ACH return or rejection (a case opens, T-0653); a duplicate-paid collection case (T-0652); the US reconciliation not finished by 06:00 IL (T-0654)
Related: REQ-INS-022..026; flag `institutions.usBanking`; ports `InstitutionBankingPort`; RUN-01 (provider outage), RUN-03 (reconciliation break), RUN-05 (webhook backlog); `docs/vendors/crowded/README.md`

## First five minutes
1. Stabilise with reversible steps only. Provider down or erroring: flip `institutions.usBanking` to `degraded` in Admin → Providers & Flags with the banner copy below. New links, payment pages, ACH funding and the nightly sweep pause; payments already collected stay with the institution at the provider and nothing in our ledger moves.
2. Confirm scope: which institutions are linked (Admin → Institutions → US banking), which calls fail (`GET /accounts`, collections, ACH), and whether the provider status page agrees. Do not re-send an ACH to "fix" it: sends carry our key, and a retry with the same key is safe; a new key is a second payment.
3. Tell `#incidents`, with the institution names and the failing call. Never paste an account number, EIN, funder name, email or mobile there; use institution ids and `ops.external_ref` ids.

## Resolution path
- **Provider down.** Wait for recovery; the workflows retry with back-off, the client never retries. When it is back, run the nightly US reconciliation by hand (Admin → Reconciliation → US banking) so the gap since the outage is read; every break opens one case, so a rerun adds none.
- **Webhook signature failures.** Rejected rows are in `ops.inbound_rejected`. A single bad sender is noise; a run of failures right after a rotation means the secret differs. Rotate ours in the secrets manager (the receiver keeps a second slot, so both verify during the change), re-register with `tools/crowded-webhooks.mjs`, then replay stored events from the admin replay path. The stored body is intact for forensics. Events are hints: payment state is re-read from the provider, so a replay cannot post from an event body.
- **ACH returned or rejected.** The case names the funding request. Nothing posted in our ledger when it was sent (the deposit posts only when the credit arrives with its KC- reference), so there is nothing to reverse. Tell the requester through the case; a new funding request needs a new quote and a second finance approver.
- **A collection paid twice.** A provider payment ref marks its fee paid once (unique on the ref); a second payment of the same fee opens a case. Refund the extra payment at the provider (their console, by the institution's finance staff), then record it by the refund row. Money here is the institution's own, outside Kesher's ledger: never edit `org.fee_external_payment`; corrections append rows.
- **Reconciliation break.** Work it like RUN-03: one case per provider ref. A provider payment with no row is created through the same insert as T-0652; an outbound ACH with no request is escalated to finance before anything else.
- Re-enable `institutions.usBanking` once the contract check is green for a night and the reconciliation is at zero breaks.

## Member message
Institution staff (console banner, no member notification): "Our US banking partner is having trouble. Payments your families already made are safe at the bank. New payment links and funding are paused and will resume on their own." · Channel: banner

## Verify it is over
- `port_error_rate` under 5% for 30 minutes and the contract check green for a night.
- Zero unprocessed rows older than 5 minutes for provider `crowded` in `ops.inbound_event`.
- The US reconciliation finished by 06:00 IL with no open break.
- Post-incident note within 2 business days.
