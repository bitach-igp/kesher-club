---
name: club-task-slicer
description: Turn a Kesher Club requirement (REQ) into agent-executable task cards in the repo's specs/tasks format, each at most one day and about 400 changed lines, with files, test-first ids and done criteria. Use when planning work for a REQ, splitting a large card, or adding cards to the task index.
---

# Club task slicer

One card = one reviewable PR an agent can finish in under a day. Cards live in `specs/tasks/T-NNNN.md` and are indexed in `specs/tasks/README.md`.

## Card format (exact)
```
# T-0201 [P] [LED] Ledger core post() + invariant trigger
REQ: REQ-LED-001, REQ-LED-002 · Sprint: 4
Files: db/migrations/ledger/0001_init.sql, apps/api/src/ledger/post.ts
Test first: TST-LED-001, TST-LED-002
Done when: listed tests pass; `pnpm typecheck`, `pnpm test`, `pnpm trace` green; only listed files touched
Out of scope: anything not named above. Stop and ask on conflict with the spec.
```
- `[P]` only if no other open card touches the same files (safe in parallel); otherwise omit it.
- `[MOD]`: AUTH, LED, WAL, CRD, PAY, INS, FX, PO, MKT, ESIM, AGT, NOT, ADM, CMP, SETUP.
- **Files** lists every file the card may create or change. Can't list them? The card is too vague; slice again.
- **Test first** lists `TST-` ids; money and auth cards (LED, WAL, CRD, PAY, PO, FX, AUTH, AGT) always have one.

## Numbering
Each epic owns a hundred-block: 00xx setup, 01xx auth, 02xx ledger, 03xx billing, 04xx card, 05xx wallet/P2P, 06xx institution, 07xx marketplace/eSIM/insurance, 08xx notifications, 09xx admin, 10xx agent/MCP. Take the next free number.

## Slicing rules
1. ≤ 1 day and about ≤ 400 changed lines including tests. Bigger: split along schema / domain logic / API / UI / adapter.
2. Each card leaves `main` green and shippable behind its flag.
3. Order by dependency; write "after T-NNNN" on the REQ line when a card needs another merged first.
4. UI cards reference the Tab 2 screen spec and the tokens package; no new colours or spacing values.
5. Never put two modules' money logic in one card.

## Index row
Add to `specs/tasks/README.md` in ID order:
`| [T-0201](T-0201.md) | LED | Ledger core post() + invariant trigger | REQ-LED-001 | 4 |`

Then run `pnpm trace`: every REQ needs at least one card and one test id.
