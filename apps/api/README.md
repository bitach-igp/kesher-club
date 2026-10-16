# apps/api

The HTTP API: auth, ledger, billing, institutions, add-ons, approvals, notifications, events,
audit, flags, the MCP resource server and pending intents. Framework-agnostic handlers
(`Handler<Req, Res>` over `HttpRequest`) with a `node:http` dispatcher in `server.ts`; the NestJS
binding is ADR-001 and changes nothing in the handlers.

## Shape

- `app.ts` — composition root: wires every service against the DB and the ports' simulators or
  adapters. Feature-off routes answer `FEATURE_OFF` through `notYet()`.
- `routes.ts` — the route table, checked against `contracts/openapi.yaml`.
- `http.ts` — `route()` maps `DomainError` / `HttpError` to RFC 9457 problem+json.
- `auth/` — OTP, passkeys (WebAuthn ceremonies through `AuthPort`), ES256 access tokens (10 min),
  rotating refresh tokens with family revocation, step-up, the 24 h recovery hold.
- `ledger/` — `post()` (insert-only, balanced, idempotent by key, reversals once) and accounts.
- `billing/`, `legal/`, `institutions/`, `addons/`, `transfers/`, `approvals/` (two-person),
  `notify/`, `events/` (Standard Webhooks), `audit/` (hash chain), `flags/` (registry in
  `config/flags.json`, state in `ops.flag_state`), `webhooks/` (inbound store, dedupe, replay),
  `mcp/` (RFC 9728 metadata, audience-bound tokens, CIMD with SSRF guard, scope tiers, 60/min,
  untrusted wrapping), `intents/` (proposals a human approves with a passkey).
- `test-db.ts` — PGlite applies `db/roles.sql` and every migration, so tests run the real SQL,
  triggers, grants (`asRole('club_app')`) and RLS in-process.

## Commands

```
pnpm --filter @kesher/api typecheck
pnpm --filter @kesher/api test
pnpm --filter @kesher/api start      # node:http on PORT; missing config crashes on boot
```
