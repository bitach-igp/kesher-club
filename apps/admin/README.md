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

## Data (ADR-013)

Screens read and write through the `AdminData` port (`src/data/types.ts`), chosen once by
`ADMIN_DATA`:

- `api` (everywhere but local and preview): `src/data/http.ts` calls `/admin/*` on the API through
  the typed SDK. Each call carries a 5-minute ES256 staff token signed with the console's own key
  (`ADMIN_API_SIGNING_KEY`, a private P-256 JWK; `ADMIN_API_SIGNING_KID`), `aud kesher-api:admin`,
  `sub` the Identity Center subject, roles from the SSO session. The API verifies it against the
  console's public JWKS and refuses member and agent tokens on admin routes. The console never holds
  a database URL or a member token.
- `memory` (local and preview only): the seeded store in `src/data/memory.ts`, invented data.

T-0906 binds flags, bindings and the audit log; customers (T-0907) and complaints and alerts
(T-0908) answer `UNAVAILABLE` on the API binding until their endpoints land.

## Commands

```
pnpm --filter @kesher/admin typecheck
pnpm --filter @kesher/admin test
pnpm --filter @kesher/admin dev     # needs the ADMIN_* env vars; missing ones crash on boot
```

Generate a staff signing key for a new environment (never commit it):

```
node -e "const {generateKeyPairSync}=require('crypto');const k=generateKeyPairSync('ec',{namedCurve:'P-256'});console.log(JSON.stringify(k.privateKey.export({format:'jwk'})));console.log(JSON.stringify(k.publicKey.export({format:'jwk'})))"
```

The first line is `ADMIN_API_SIGNING_KEY`; the second (plus `kid`, `alg: ES256`, `use: sig`) goes
into the API's staff JWKS.
