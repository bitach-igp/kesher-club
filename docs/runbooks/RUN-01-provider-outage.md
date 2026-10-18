# RUN-01 Provider outage
Owner: on-call engineer · Severity: SEV2 (SEV1 if cards or loads are down for many members) · Last tested: never
Alert: `port_contract_check_failed` (nightly contract suite red against the sandbox or live adapter) or `port_error_rate` over 5% for 5 minutes on any port
Related: REQ-LED-003, REQ-WAL-002, REQ-PO-002; flags `wallet.enabled`, `card.virtual`, `p2p.enabled`, `fx.enabled`, `payouts.nium`, `esim.airalo`; ports `FundingPort`, `CardIssuingPort`, `FxPort`, `PayoutPort`, `KycPort`, `EsimPort`

## First five minutes
1. Confirm the outage on the provider's status page and in our error-rate panel. One port, or several? One market, or both?
2. Flip the capability to degraded with banner copy: in the admin console, Providers & Flags, set the port's binding to `degraded` (`listAdminBindings` shows the current binding). The app shows the feature-off state with the banner text; members see nothing broken.
3. Pause the dependent workflows: the worker sweeps for that port (`LoadWorkflow.sweep`, `PayoutWorkflow.sweep`, `SendWorkflow.sweep`) stop advancing; in-flight transfers stay `submitted` and are safe to retry.
4. Tell `#incidents`: the RUN, the port, the scope, who is driving. Tell the bank contact if cards or loads are affected.

## Resolution path
- Watch the retry queue drain on recovery: `submitted` transfers with the same idempotency key replay through the port; nothing posts twice (REQ-LED-003).
- Run the reconciliation job for the affected provider once the provider is back (`ReconJob`); every break opens an `ops.case` of kind `recon_break`.
- Money corrections, if any, are reversing journals with two-person approval. Never edit `ledger.*` rows.
- Flip the binding back from `degraded` in the order Tab 1 lists; a money binding needs two admins (REQ-ADM-002).
- Post-incident note within 2 business days.

## Member message
"Card top-ups are delayed. Your money is safe." · Channel: banner (and push to members with a transfer in flight)

## Verify it is over
- Port error rate under 1% for 30 minutes; the contract suite green on the next run.
- Reconciliation at zero breaks for the provider's next statement.
- No transfer older than one hour left in `submitted` for that port.
