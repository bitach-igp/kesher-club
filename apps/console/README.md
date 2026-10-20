# apps/console

Next.js institution console, screens I01-I14 (Tab 2). Staff of an institution (`org_staff`,
`org_finance`, `org_admin`) sign in with the passkey of the member account they already have; the
console's server keeps the token pair in httpOnly cookies and calls the API with it (T-0608).

- `proxy.ts` resolves the session before every page: signed out goes to `/sign-in`; an expired access
  token refreshes once and then signs out; no org role or no active staff row lands on "no institution
  access". `src/session.ts` holds that logic; `src/session.test.ts` pins it.
- `GET /me/institution` names the staff member's institution and role. Their institution is the only one
  the console shows.
- Config (`src/config.ts`, crashes when missing): `CONSOLE_ENVIRONMENT` (`local` | `preview` | `staging` |
  `production`) and `CONSOLE_API_URL` (with `/v1`).

## Run it locally

With the demo stack running and the yeshiva seeded (docs/setup/demo.md, T-0034):

```sh
CONSOLE_ENVIRONMENT=local CONSOLE_API_URL=http://localhost:3000/v1 pnpm --filter @kesher/console dev
```

Open <http://localhost:3200>. A local console lists the seeded finance staff (Rivka, Shimon) under the
passkey button; each signs in with its seeded passkey. Any other environment shows the passkey button only.
