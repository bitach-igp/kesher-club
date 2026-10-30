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
- Every task card through T-0618 is implemented with its tests and merged (plus the setup fixes through
  T-0036): auth, ledger, billing, card, wallet, P2P, FX, payouts, institutions (deposits, US ACH pulls,
  the bank feed, KYB, credit lines, allowances, collections), marketplace, notifications, admin, the agent's
  authorization server and monitoring. All 81 requirements of the first phase have a card and a test.
- The money flows run end to end against the simulators, and all 18 bank-review walkthroughs record in one
  run (`docs/bank-review/`). The desktop checker has applied every migration on Postgres 16.
- Decided: ADR-001 (modular monolith), ADR-002 (Temporal Cloud when the money flags turn on), ADR-003 (our
  own Postgres sub-ledger), ADR-004 (WorkOS), ADR-005 (the flag registry as built), ADR-007 (native ILS),
  ADR-008 (in-house webhooks), ADR-009 (our own MCP authorization server), ADR-010 (the house components),
  ADR-013 to ADR-016. ADR-017 (KYB gates) is built and with the bank for review.
- Waiting on others: ADR-006 (processor and sponsor bank; every vendor adapter and money flag waits on it),
  T-0030's AWS steps, and the bank's questions in `docs/bank-review/institution-kyb.md`.
- Next: the next-phase plan approved on 2026-10-30, sprints 12 to 15. Sprint 12 is the ops queue, the
  suspense-credit resolution, webhook hardening and the plan catalogue (T-0037, T-0207, T-0631, T-0930 to
  T-0933); then funder sign-up and the family screens, the rest of the institution console with self-serve
  KYB, the member app's remaining screens, and launch readiness.
- Desktop-only steps go through `handoff/` (see `handoff/README.md`).

## Quick start
```
corepack enable
pnpm install
pnpm test
```
