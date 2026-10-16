---
name: club-adapter
description: Scaffold a Kesher Club provider port or vendor adapter - port interface, stateful simulator with deterministic failure fixtures, contract suite, registry wiring and flag - following the ports-before-vendors rule. Use when adding an external capability (card issuing, KYC, payouts, FX, eSIM, insurance, messaging) or a new vendor for an existing port.
---

# Club adapter

Constitution art. 1: every external capability is a port in `packages/ports` with a simulator that passes the port's contract suite. App and domain code never import a vendor SDK. The eSIM port (`packages/ports/src/esim*.ts`) is the reference; copy its shape.

## New port `<cap>` (e.g. `payout`)
| File | What |
|---|---|
| `packages/ports/src/<cap>.ts` | `<Cap>Port` interface, DTOs, and `<Cap>Error` with a closed `code` union (always include `PROVIDER_UNAVAILABLE`). Money is `Money` from `@kesher/domain`. Mutating methods take an `idempotencyKey`; the same key returns the same result. |
| `packages/ports/src/<cap>.simulator.ts` | `class <Cap>Simulator implements <Cap>Port`: in-memory state, injectable clock, deterministic fixtures (one input that always fails with `PROVIDER_UNAVAILABLE`, documented in the header), control hooks for the simulator panel. |
| `packages/ports/src/<cap>.contract.ts` | `export function <cap>Contract(name, make, opts)`: a vitest `describe` with what every implementation must do: happy path, idempotency, error mapping, money invariants. No vendor specifics. |
| `packages/ports/src/<cap>.simulator.test.ts` | Runs `<cap>Contract('simulator', () => new <Cap>Simulator())` plus simulator-only tests. |
| `packages/ports/src/index.ts` | Export the new types, simulator and contract. |

## New vendor adapter
| File | What |
|---|---|
| `packages/adapters/<vendor>/src/<cap>.ts` | `implements <Cap>Port`. Maps vendor statuses to our enums and vendor errors to `<Cap>Error` codes. Unknown vendor responses fail secure. |
| `packages/adapters/<vendor>/src/<cap>.contract.test.ts` | Runs the same `<cap>Contract` against the vendor sandbox; skipped without sandbox credentials; nightly in CI. |
| Webhooks | Land in `ops.inbound_event` first (signature verified, deduped by provider event id); a worker maps them to domain events. Never processed in the HTTP handler. |
| Ids | Vendor ids only in `ops.external_ref`. |

## Wiring
- `registry.register('<cap>', '<vendor>', mode => mode === 'sim' ? new <Cap>Simulator() : new <Vendor><Cap>Adapter(mode))`
- Bind per market (`US` / `IL`) with mode `sim` | `sandbox` | `live`. The registry fails closed: an unbound capability throws.
- Gate user-facing use behind a flag in `config/flags.json` (default `false`).
- Switch-on order (Tab 1): contract signed → sandbox keys → adapter passes the contract suite → certification scenarios → disclosures approved → internal cohort → pilot → GA.

## Rules
- No retries in adapters; retries belong to the Temporal workflow calling the port.
- Never log PAN, CVV, OTPs, tokens or PII, including in simulator fixtures.
- Test first for money ports (CardIssuing, Payout, Fx, Funding).

Done when typecheck and `pnpm -r --filter "./packages/*" exec vitest run` are green and the contract suite runs for the simulator.
