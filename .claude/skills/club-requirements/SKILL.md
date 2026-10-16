---
name: club-requirements
description: Write or change Kesher Club requirements (REQ rows) in the build-ready spec format, with RFC 2119 wording, a Given/When/Then acceptance and a flag column. Use when adding a requirement, changing one, or turning a product ask into REQs. Refuses rows without an acceptance or a flag column.
---

# Club requirements

A requirement is one row. It is testable, owned by one module, and gated by a flag when the feature depends on a partner.

## Row format (Tab 3 §2-3 of the live spec)

| ID | P | Requirement | Acceptance | Flag |
|---|---|---|---|---|
| REQ-LED-001 | P1 | Every journal MUST sum to zero per currency; a non-balancing `post()` MUST raise and write nothing. | Given postings of +100 / −99 USD, when posted, then error `UNBALANCED` and no rows. | — |

Rules, all enforced:
1. **ID** `REQ-<MOD>-NNN`. Modules: AUTH, LED, WAL, CRD, PAY, INS, FX, PO, MKT, ESIM, AGT, NOT, ADM, CMP. Take the next free number in that module; never reuse a retired one.
2. **P** is `P1` (launch blocker), `P2` (launch) or `P3` (later).
3. **Requirement** uses MUST / MUST NOT / SHOULD. One behaviour per row. Numbers carry units (`5 minutes`, `₪800 a day`). No implementation names unless the constitution fixes them.
4. **Acceptance** is a single Given / When / Then with concrete values, checkable by an automated test. No GWT: refuse the row and say what is missing.
5. **Flag** is `—` or keys that already exist in `config/flags.json`. A new flag goes into `config/flags.json` with default `false` in the same change. Missing column: refuse.
6. Money amounts in acceptance criteria name the currency. Money logic is never `number`.

## Where it goes
- The live spec, Tab 3 (source of truth): https://claude.ai/code/artifact/e15792e3-bcbb-4c34-b66e-c3f62abf4b2d
- The repo snapshot `specs/requirements.md`: add `| REQ-… | P? | short title |` in ID order.
- Every REQ needs a test `TST-<MOD>-NNN` with the same number and at least one task card (use `club-task-slicer`). `pnpm trace` (tools/trace-check.mjs) fails otherwise.

## Before you finish
- [ ] GWT present and concrete
- [ ] Flag column filled; flags exist in `config/flags.json`
- [ ] Snapshot row added to `specs/requirements.md`
- [ ] Task card(s) created or listed as follow-up
- [ ] `pnpm trace` green, or the missing test/task named in your reply
