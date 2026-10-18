# CLAUDE.md

Read `AGENTS.md` first: it is the rulebook (money as `Money { minor: bigint }`, ports before vendors,
insert-only ledger, flags only in `config/flags.json`, untrusted text, the desktop handoff). This file
adds what a session needs to work here without rediscovering it.

## Working a card
- One card (`specs/tasks/T-NNNN.md`) per commit and per PR. Commit as `feat(scope): what [T-NNNN]`.
- Touch only the card's files. Three files are shared plumbing and may be touched when a card needs
  them, said so in the PR: `apps/api/src/app.ts` (composition root), `apps/api/src/routes.ts` (must
  equal the OpenAPI operations, methods GET/POST/PATCH/DELETE only, no PUT), and the hand-kept
  `HEADER_OPS` table in `packages/sdk/src/client.ts`.
- Done means the card's tests pass and `pnpm typecheck`, `pnpm lint`, `pnpm test` and `pnpm trace` are
  green, plus `pnpm db:lint` when a migration changed.

## Where things live
- Deterministic workflow bodies (`runLoad`, `runSend`, `runPayout`) live in `apps/api`; `apps/worker`
  hosts them and the sweeps and imports them as `@kesher/api/<path>` (no `.ts` suffix across packages).
- Every money movement is an `ops.transfer` driven through `TransferService` (create → submit → settle,
  or hold / release / fail / cancel); its idempotency key is the workflow id. Journals use the same key
  (`{key}:settle`, `{key}:hold`, …) so a replay finds its own work.
- Vendor ids map through `ops.external_ref`, never a column of their own.
- Simulators (`@kesher/simulators` `SimulatorHost`) stand in for every vendor in tests; fixtures such as
  `pm_ok` / `pm_norefund` choose the outcome.

## Tests
- API tests build a real schema in PGlite with `createTestDatabase()` and drive the app through
  `dispatch(app, { method, url, headers, rawBody, now })`. Money asserts compare `bigint`.
- `uuidv7()` ids minted in the same millisecond tie on time: order by `max(transfer_event.id)` or by an
  explicit column, never by id alone, and never derive anything short from an id's leading digits.
- Advancing a test clock past token expiry costs the bearer and the step-up: re-sign in or call the
  service directly.
- Idempotency keys are 8 to 128 characters; shorter ones answer 422.

## Contract and SDK
- Change `contracts/openapi.yaml` (see the `club-openapi` skill), add the route, then regenerate:
  `pnpm --filter @kesher/sdk generate`. Lint with
  `npx --yes @stoplight/spectral-cli@6.15.0 lint contracts/openapi.yaml --ruleset .spectral.yaml`.
- The server always JSON-encodes the body: a binary export travels as a base64 envelope.
- Error codes are a closed set (`QUOTE_EXPIRED` 409, `LIMIT_EXCEEDED` and `INSUFFICIENT_FUNDS` 422,
  `FEATURE_OFF` 404, `STEP_UP_REQUIRED` 401, `IDEMPOTENCY_CONFLICT` 409 for state conflicts,
  `PROVIDER_UNAVAILABLE` 503). `DomainError(code, message, extra)` spreads `extra` into the problem body.

## Migrations
- Forward-only, numbered, under `db/migrations/<schema>/` (see the `club-ddl` skill). After adding one:
  `atlas migrate hash --dir file://db/migrations/ledger` to refresh `atlas.sum`, then `pnpm db:lint`.
- A new constraint goes on `NOT VALID` when every existing row already satisfies it (Squawk, and no scan).
- The real Postgres apply happens on the desktop: commit a request in `handoff/desktop/` per
  `handoff/README.md`. Put each statement whose success another one depends on in its own `psql -c`;
  one `-c` is one transaction, so a deliberately failing insert rolls back its predecessors.

## TypeScript house style
- `exactOptionalPropertyTypes` is on: spread optional fields conditionally (`...(x ? { x } : {})`) and
  type possibly-missing values as `T | undefined` on the way in.
- ESLint flags useless escapes, useless assignments and unused imports; a literal BOM or other
  irregular whitespace goes in as an escape (`\uFEFF`).
- Mobile copy lives in `apps/mobile/src/i18n.ts` with English and Hebrew mirrored; screens read a model
  over `createStore` / `useStore`, and optional component props use the conditional spread.
