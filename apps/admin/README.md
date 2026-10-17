# apps/admin

Next.js back office (SSO + VPN only), areas A01-A08.

## Access (T-0116, REQ-AUTH-009)

`proxy.ts` runs in front of every request: the client IP (first hop of `x-forwarded-for`, as the
ALB sets it) must be inside `ADMIN_VPN_CIDRS` or the answer is 403 for every path, the sign-in page
included. Then the session cookie (the Identity Center ID token, ES256, verified against
`ADMIN_OIDC_JWKS_URL`) must carry a phishing-resistant `amr` (`hwk`, `fido`, `webauthn`), or the
admin is sent to `/auth/sign-in` with the reason. The pure gate is `src/auth/proxy.ts`; the OIDC
code flow is `app/auth/{start,callback}`. All config is required at boot (`src/config.ts`).

## Areas built

| Card | Area | Where |
| --- | --- | --- |
| T-0901 | Shell, A01 Customer 360 (masked identity, KYC, balances, cards, cases, consents, grants, audit) | `app/layout.tsx`, `app/customers/` |
| T-0902 | A07 Providers & flags: bindings, switch-on checklist (release gates, Tab 3 §11), two-person flip, kill switch | `app/providers/`, `src/providers/` |
| T-0904 | A02 alert queue, A03 complaints with SLA timers (ack 2 / resolve 15 business days, red at day 13) and the bank CSV export | `app/compliance/`, `src/compliance/` |

## Data

Screens read and write through the `AdminData` port (`src/data/types.ts`). The day-one binding is
the seeded in-memory store (`src/data/memory.ts`, invented data) so the console runs in local and
preview environments. The API-backed binding lands with the admin endpoints (ADR pending); nothing
in `app/` changes when it does.

## Commands

```
pnpm --filter @kesher/admin typecheck
pnpm --filter @kesher/admin test
pnpm --filter @kesher/admin dev     # needs the ADMIN_* env vars; missing ones crash on boot
```
