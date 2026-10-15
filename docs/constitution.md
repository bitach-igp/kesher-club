# Constitution (v0.1.0, ratification pending: Zvi, Ezra, Noah)

1. **Ports before vendors.** Every external capability is a versioned port in `packages/ports` with a simulator that passes the port's contract suite. No app or domain code imports a vendor SDK.
2. **Never hold the money.** Customer funds sit with the sponsor bank or a licensed partner. Our ledger is a shadow until the ISA licence; reconciliation must reach zero breaks.
3. **Ledger is law.** Double-entry, append-only, bigint minor units, sum-to-zero per currency per journal, idempotent by key. No UPDATE or DELETE on `ledger.*`.
4. **Money moves only in workflows.** Every transfer is a Temporal workflow with ID = idempotency key. HTTP handlers start workflows; they never call providers directly.
5. **Test-first for money and auth.** LED, WAL, CRD, PAY, PO, FX, AUTH, AGT: failing tests first, including ledger property tests and port contract tests.
6. **Fail secure.** Missing config crashes on boot. Unknown provider responses decline. Authorisation times out to decline unless partner stand-in applies.
7. **Humans approve money that agents ask for.** Agent-originated money movement creates a pending intent approved in-app with a passkey.
8. **Flags, not branches.** Unfinished or vendor-gated work merges behind a flag that defaults off. `config/flags.json` is the only list of flags.
9. **Least data.** Collect only what a requirement needs, encrypt PII at field level, keep vendor ids only in `ops.external_ref`.

Amendments: PR to this file approved by two founders. A major bump means existing plans are re-checked.
