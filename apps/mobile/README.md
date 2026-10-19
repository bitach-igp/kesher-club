# apps/mobile

Expo app: member mode and funder mode. Screens M01-M34 and P01-P18 (Tab 2).

## Shape

- `app/` — expo-router routes. Each screen is a thin view over a view model; the default export
  builds the model from the app contexts, the named `*View` takes a model (tests and previews).
- `app/**/*.model.ts` — view models: plain objects over a `Store` (`src/model.ts`), driven by
  injected deps (API, authenticator, router, device, opener, clock). Tested without React.
- `src/api.ts` — narrow API surfaces per screen, bound to the `@kesher/sdk` client in `sdkApi()`.
  Screens never see `fetch` or vendor code. Operations the contract does not expose yet (eSIM
  usage, concierge, invites) are `extras` the shell wires.
- `src/components/` — the Tab 2 component library on React Native primitives, themed from
  `@kesher/tokens` (light/dark, Dynamic Type, RTL for Hebrew).
- `src/i18n.ts` — en + he screen copy; `{placeholders}` are filled as text, never interpreted.
- Seams the root layout (`app/_layout.tsx`, T-0033) binds: `navigation.ts` (expo-router), `passkeys.ts`
  (WebAuthn on web, seeded passkeys in a development build; expo-passkeys on native later), `linking.ts`
  (Linking), `session.ts` (install id in localStorage on web; secure store on native later). Still to
  bind with the native build: `device.ts` (expo-device, expo-location, clipboard) and `support.ts`
  (public contact numbers).

## Screens built

| Card | Screens | Route files |
| --- | --- | --- |
| T-0113 | M03 sign in / sign up (passkey first, OTP for sign-up and recovery), M04 invite | `app/(auth)/` |
| T-0713 | M25 club hub, M26 eSIM plans + checkout, M27 install, M28 usage | `app/club/` |
| T-0730 | M31 help hub, M32 emergency | `app/help/` |
| T-1006 | Assistants: grants, one-tap revoke, rate-limit copy | `app/settings/assistants/` |

## Run it in a browser (T-0033)

The Expo project (`app.json`, `metro.config.js`, `app/_layout.tsx`) serves the app with Expo web against
the local demo stack (`docs/setup/demo.md`). Start that stack and seed it (`pnpm --filter @kesher/demo dev`,
then `pnpm --filter @kesher/demo seed`), then:

```sh
EXPO_PUBLIC_API_URL=http://localhost:3000 EXPO_PUBLIC_APP_ENV=development pnpm --filter @kesher/mobile web
```

On Windows PowerShell, set `$env:EXPO_PUBLIC_API_URL` and `$env:EXPO_PUBLIC_APP_ENV` first.

- Open <http://localhost:8081>. Signed out, the root layout routes to sign-in; signed in, to home.
- Both variables are read at build time and are required. `src/config.ts` refuses a non-`https` API URL
  unless the host is `localhost` (or `127.0.0.1`, `[::1]`). The demo API answers CORS for localhost
  origins only.
- **Development build** (`EXPO_PUBLIC_APP_ENV=development`): sign-in shows a strip of the seeded people
  (T-0032). Pick one, or open `/?persona=dana`, and "Sign in with passkey" signs with that persona's
  seeded passkey (`@kesher/ports/seeded`). No hardware key is needed.
- **Every other build** uses the browser's WebAuthn. The choice is made by the build alone: the bundler
  inlines `process.env.EXPO_PUBLIC_APP_ENV` and drops the development branch. An exported `prod` web
  bundle contains no persona and no seeded-passkey code. Nothing the API answers switches it.
- The install id that every passkey ceremony sends (T-0120) is kept in `localStorage` on web.
- Known noise, development only:
  - Expo Router warns that each `*.model.ts` under `app/` lacks a default export, because it takes every
    file there for a route. Moving the view models out of `app/` silences it.
  - React Native Web logs "Invalid style property of direction" from a dependency.

## Tests

`pnpm --filter @kesher/mobile test` runs the view-model tests on Node and screen smoke tests
through react-native-web in jsdom (`// @vitest-environment jsdom`). The Maestro rows of
TST-AUTH-001 and TST-ESIM-001 need an Expo dev build and a phone; they are not in the repo yet
(the Expo project config and the Maestro flows come with the first dev build).
