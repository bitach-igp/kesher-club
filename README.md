# Kesher Club (working name)

Parent-funded membership for Anglo students in Israel: USD/ILS wallet and card, P2P between
members, yeshiva master accounts, eSIM, insurance and a 24/7 help line.

**Build first, switch on later.** Every outside provider sits behind a port with a simulator.
When a contract is signed we add the vendor adapter, pass the port's contract suite against the
vendor sandbox, and flip a flag. See `docs/constitution.md` and the live spec.

## Layout
| Path | What |
|---|---|
| `apps/api` | NestJS modular monolith (HTTP, JIT auth, webhooks) |
| `apps/worker` | Temporal workers, outbox and webhook consumers |
| `apps/mobile` | Expo app (member + funder mode) |
| `apps/web`, `apps/console`, `apps/admin` | Next.js: parent portal, yeshiva console, back office |
| `apps/simulators` | Stateful simulators + control panel for every port |
| `packages/domain` | Money, errors, reference ledger (working, tested) |
| `packages/ports` | Port interfaces, simulators, contract suites, provider registry (eSIM done) |
| `packages/adapters` | Vendor adapters (Airalo, Stripe, Nium, card processor…) |
| `contracts/openapi.yaml` | API source of truth |
| `db/migrations` | Atlas migrations; `ledger/0001_init.sql` ready |
| `specs/tasks` | Agent-executable task cards, indexed in `specs/tasks/README.md` |
| `docs/adr` | ADR-001…013 (006: processor and bank, 007: native ILS, 012: core platform, 013: admin through the API) |
| `docs/runbooks` | RUN-01…08, the on-call rota and the alert index |
| `config/flags.json` | The only flag registry |

## Status
- Every task card through T-1007 is implemented with its tests and merged: setup, auth, ledger,
  billing, card, wallet, P2P, FX, payouts, institutions, marketplace, notifications, admin, agent and
  monitoring. `pnpm typecheck`, `pnpm test`, `pnpm lint`, `pnpm trace` and `pnpm db:lint` are green at
  the root; the desktop checker has applied every migration through ledger/0012 on Postgres 16.
- Decided: ADR-004 (WorkOS for institution SSO and SCIM), ADR-007 (ILS is native: every load, send and
  receipt names its currency; conversions at the club-published rate) and ADR-013 (the admin console
  talks to the API), and ADR-014 (pricing and the spec-versus-code calls from the bank-review package). ADR-006's build decision: the money epics run against the simulators; the
  processor adapter is one later card per port. ADR-001, 002, 003, 005, 008 and 010 carry draft
  recommendations awaiting Zvi.
- Next: the currency-choice and club-rate cards T-0512 to T-0518 (ADR-007), and the Sprint 9 cards
  T-0013, T-0014 and T-0910 to T-0912 (Hebrew/RTL pass, pentest readiness, runbooks and status page,
  the bank-review package). Switch-on starts with Airalo once a contract and sandbox keys exist
  (Tab 1 of the live spec); every money flag waits on ADR-006.
- Desktop-only steps go through `handoff/` (see `handoff/README.md`).

## Quick start
```
corepack enable
pnpm install
pnpm test
```
