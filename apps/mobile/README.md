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
- Seams the real app binds in its root layout: `navigation.ts` (expo-router), `passkeys.ts`
  (expo-passkeys), `linking.ts` (Linking), `device.ts` (expo-device, expo-location, clipboard),
  `support.ts` (public contact numbers), `session.ts` (secure store).

## Screens built

| Card | Screens | Route files |
| --- | --- | --- |
| T-0113 | M03 sign in / sign up (passkey first, OTP for sign-up and recovery), M04 invite | `app/(auth)/` |
| T-0713 | M25 club hub, M26 eSIM plans + checkout, M27 install, M28 usage | `app/club/` |
| T-0730 | M31 help hub, M32 emergency | `app/help/` |
| T-1006 | Assistants: grants, one-tap revoke, rate-limit copy | `app/settings/assistants/` |

## Tests

`pnpm --filter @kesher/mobile test` runs the view-model tests on Node and screen smoke tests
through react-native-web in jsdom (`// @vitest-environment jsdom`). Maestro flows for the
TST-*-Maestro rows run on the desktop against a dev build (handoff request to follow).
