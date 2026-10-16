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
| `specs/tasks` | 56 agent-executable task cards |
| `docs/adr` | ADR-001…012 (012: core platform) |
| `config/flags.json` | The only flag registry |

## Status
- 55 of the 56 task cards in `specs/tasks` are implemented with their tests; `pnpm typecheck`,
  `pnpm test`, `pnpm lint`, `pnpm trace` and `pnpm db:lint` are green at the root.
- Open: T-0118 (OrgIdP vendor adapter) waits on ADR-004; the port and simulator exist.
- Deferred by ADR: NestJS binding (ADR-001), Temporal hosting (ADR-002); the E04/E05 money epics
  (wallet, cards, P2P, FX, payouts) are not yet broken into cards (ADR-006), which is why
  `pnpm trace` lists their REQs as "not yet in any task".
- Desktop-only steps go through `handoff/` (see `handoff/README.md`).

## Quick start
```
corepack enable
pnpm install
pnpm test
```
