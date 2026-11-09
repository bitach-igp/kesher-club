# Re-taking the committed screenshots (T-0073)

The pictures under `handoff/done/*.png` are evidence for cards (what the member app, the institution console and
the admin console looked like when a card was checked in a browser). After a redesign they go stale, so one script
re-takes all of them from the running product, and one manifest says what each picture is.

- `tools/screenshots/manifest.json` lists every png: the card that first made it, the app, the persona, the route,
  the locale, the viewport, the theme and the state it shows. `status` is `recorded` (the script re-takes it) or
  `not-retaken` (with a `reason`).
- `tools/screenshots/manifest.test.mjs` (part of `pnpm test`) fails when a png under `handoff/done` is not in the
  manifest, or an entry has no file. Adding a screenshot therefore means adding its entry, and a scenario in
  `record.mjs` that takes it.
- `tools/screenshots/record.mjs` starts the stack, drives it with Playwright's Chromium and writes each image under
  its existing file name, so the cards that link them stay valid.
- `tools/screenshots/stack.mjs` starts the stack alone, for trying a flow by hand.

## Run it

Needs Node 22, the workspace installed (`pnpm install`), and Playwright with its Chromium on `NODE_PATH` (the
repository does not install one: `require('playwright')` must resolve). Ports 3000, 3100, 3200, 4010, 4099 and 8081
must be free. No Docker is needed: the stack is the T-0031 process on an in-memory database
(`apps/demo/src/record/stack.ts`, the one the T-0920 recordings use), seeded by T-0032 and T-0034.

```sh
node tools/screenshots/record.mjs
```

It starts the demo process, the member app's web build (T-0033), the admin console (T-0919) and the institution
console (T-0608), re-takes every entry, stops them, and then checks that every `recorded` entry was taken and nothing
else was. It takes about ten minutes, most of it `next dev` compiling. Options:

| Option | Meaning |
|---|---|
| `--only a,b` | only the scenarios named (ids in `SCENARIOS`); later scenarios can need the state earlier ones leave |
| `--out <dir>` | write the images there instead of `handoff/done` |
| `--attach <logDir>` | use the stack `node tools/screenshots/stack.mjs` left running (its `staff.json` holds that run's throwaway key) |

## How the pictures are made

- `deviceScaleFactor: 2`; the viewport is the entry's, in CSS pixels. Console pages are taken full page.
- Light theme and English only, except `T-0610-hebrew.png` (Hebrew, right to left): the originals showed no other
  variant. A dark or Hebrew variant of a picture is a new manifest entry with a suffixed name, taken by a new
  scenario.
- The scenarios run in order on one stack, because state carries on: Dana's purses, the yeshiva's account, the
  clock (the payouts scenario moves it 24 hours). Dana's Home is taken first, with her seeded $500.00.
- Persona sign-in uses the seeded passkeys (the development build's persona bar, the console's local persona
  buttons). Data a screen needs is made through the API as the people who would make it: Kesher finance records and
  approves a deposit, Rivka makes the allowance schedules and the fees, Noa pays one, Shimon decides payouts.
- Next's development badge is hidden by an injected style; it is not part of the product. Page errors are printed.
- The member app opens each screen with an in-app route change (no reload, so the session stays), the way the
  T-0920 recordings do. In this script's run the browser stayed blank at `/` after the passkey sign-in, so the script
  goes to `/home` itself. This was observed in this script's run and not reproduced elsewhere (the T-0920 recorder
  does not need the workaround on main). Nothing in the app was changed.
- Before every shot the page text is checked for a token-shaped string or a 13 to 19 digit run; the shot is refused
  if either is there. Accounts show masked (`•••• 9999`).

## What cannot be re-taken

- `T-0612-bad-iban.png` (T-0612, a payout refused for an IBAN that fails its checksum). Since T-0625 the new-payout
  form asks only for an amount and a reference: every payout goes to the institution's own verified account, so
  there is no IBAN field to get wrong. The file is the pre-redesign picture, kept so the T-0612 link resolves;
  the manifest marks it `not-retaken`.

Other states changed with the product, not only the paint: the payouts pictures now show the institution's own
account as the payee, and the cooling-off, second-approver and decided states are reached with that account.

## Not here

Store listing screenshots and the Hebrew device-matrix pass on real devices (T-0013, T-0058), changing any UI, and
screens that need a vendor sandbox.
