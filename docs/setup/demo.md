# The local demo stack

One process runs the API, every worker job and the simulators' control panel on one provider registry
and one clock (T-0031). A hook fired on the panel reaches the API's own vendor, and the panel's clock moves
the API's and the jobs' time with it, so a money flow can be driven end to end, the way the bank-review
walkthroughs need. It is for development only: `apps/demo` is never built into an image, and anything but
`APP_ENV=development` refuses to boot.

## Start it

From the repository root, with Docker and the Atlas CLI (or `--docker` to run Atlas's image):

```sh
docker compose -f apps/demo/compose.yaml up -d --wait
docker compose -f apps/demo/compose.yaml exec -T postgres psql -U postgres -d club -v ON_ERROR_STOP=1 < db/roles.sql
node db/migrate.mjs --url "postgres://postgres:postgres@localhost:5433/club?sslmode=disable"
APP_ENV=development DATABASE_URL="postgres://postgres:postgres@localhost:5433/club" pnpm --filter @kesher/demo dev
```

On Windows PowerShell, set the two variables first (`$env:APP_ENV="development"` and
`$env:DATABASE_URL="postgres://postgres:postgres@localhost:5433/club"`), then run `pnpm --filter @kesher/demo dev`.

## Where it answers

- API: <http://localhost:3000/v1> (`PORT` to change it)
- Simulator control panel: <http://localhost:4010> (`SIMULATOR_PORT` to change it). It fires vendor hooks
  (`POST /ports/{capability}/hooks/{hook}`) and moves the shared clock (`POST /clock/advance` with `{"ms": …}`).

## What it does for you

- Keys left unset (`JWT_SIGNING_KEY`, `STAFF_JWKS`, `PII_DATA_KEY`, `PII_INDEX_KEY`) are generated at start,
  held only in memory and never printed. Restarting therefore ends every session, and PII written with the
  old keys can no longer be read: reset the database (`docker compose -f apps/demo/compose.yaml down -v`)
  or pass fixed keys.
- `MARKET` defaults to `US`; set `MARKET=IL` for the Israeli flows. Each process runs one market, as in AWS.
- Every flag in `config/flags.json` is on, in memory only. The flag table is untouched, so the console's
  flag page still shows the database's state.
- The jobs run on their own cycles against the shared clock; advancing the clock does not run them early.

## Seed the personas

With the stack running, from the repository root:

```sh
pnpm --filter @kesher/demo seed
```

`DEMO_API_URL` and `DEMO_PANEL_URL` point it elsewhere; they default to the ports above. The seed makes
the people the money flows in `docs/bank-review/money-flows.md` start from, through the API and the panel
only, never by writing tables (T-0032):

- Each persona signs up with the simulator's OTP and a passkey derived from its key.
- KYC is decided through the panel's `kyc/decide` hook. The decision then reaches the API as the vendor's
  webhook, and a T2 approval issues the virtual card.
- Purses are funded with card loads (fixture `pm_ok`, settled at once).

Every keyed call derives its idempotency key from the persona (`seed-<persona>-…`). A persona that already
exists is signed in with its passkey instead of being made again, so a second run creates nothing and
prints the same table. The table holds no token.

| Persona | Name | Market | Phone | KYC | Funded with | Recordings |
|---|---|---|---|---|---|---|
| `dana` | Dana Example | US | +1 555 555 0101 | T2, virtual card open | $500.00 | REC-01, 02, 04, 05, 07, 09, 16 |
| `avi` | Avi Example | US | +1 555 555 0102 | T1 | nothing | REC-05 (Dana pays him), REC-08 |
| `noa` | Noa Example | IL | +1 555 555 0103 | T2, virtual card open | ₪5,000.00 and $100.00 | REC-03, 07, 08, 10, 13 |
| `maya` | Maya Example | IL | +1 555 555 0104 | T1 | ₪1,000.00 | REC-06 (sender) |
| `eli` | Eli Example | IL | +1 555 555 0105 | T1 | nothing | REC-06 (recipient; never paid by Maya) |
| `tamar` | Tamar Example | US | +1 555 555 0106 | T2, virtual card open | $200.00 | REC-12 |
| `ruth` | Ruth Example | US | +1 555 555 0107 | T1 | $30.00 by card | REC-17 (ready to close: no holds, every dollar refundable) |
| `ben` | Ben Example | US | +1 555 555 0108 | T1 | nothing | REC-01 funder mode, once the link below exists |
| `rivka` | Rivka Example | IL | +1 555 555 0109 | T2 | nothing | REC-14, REC-15: yeshiva finance, imports the roster; the yeshiva's KYB control person (T-0621) |
| `shimon` | Shimon Example | IL | +1 555 555 0110 | T1 | nothing | REC-14: yeshiva finance, the second approver |

Market is the market whose walkthroughs use the persona. The party itself has no market, since every
member holds both purses; a transfer takes the market of the process that wrote it. Seed and record the
IL flows against a `MARKET=IL` process. REC-11 (club rates) and REC-18 (ledger reversals) need a staff
console session (T-0919), not a member.

### The demo yeshiva (T-0034)

With the console's staff key in the environment, the seed also stands up the institution the
institution console (T-0608 onward) starts from. It goes through `/admin/*` the way two staff admins
would (REQ-ADM-004):

1. Ada Admin (`staff-admin-1`) onboards "Yeshivat Kesher (demo)", market IL.
2. Ada proposes `rivka` and `shimon` as finance, and Abe Admin (`staff-admin-2`) approves each grant.
3. Cleo Compliance (`staff-compliance-1`) approves the yeshiva's KYB at low risk (T-0621, T-0622, ADR-017):
   - she names `rivka` (T2) its control person and signatory;
   - she runs the automated checks against the KybPort simulator (amuta number `580123456`), which
     come back clear on the registry, the identifier, exempt status and the screening of the yeshiva
     and Rivka.

   Until then its deposits, allowances and payouts stay shut.
4. Cleo records the yeshiva's own bank account (`IL62 0108 0000 0009 9999 999`, fictional) in the
   registered name, and Carl Compliance (`staff-compliance-2`) approves it (T-0623). Every withdrawal
   in the console goes to that account, shown as •••• 9999 (T-0625).
5. `rivka` signs in again, so her token carries `org_finance`, and imports a three-row roster of
   fictional students (`example.test` funder addresses). They become invited members.

```sh
set -a; . ./.env.local-staff; set +a   # ADMIN_API_SIGNING_KEY; the stack must run with the matching STAFF_JWKS
pnpm --filter @kesher/demo seed
```

`ADMIN_API_SIGNING_KID` defaults to `local-staff-1`. Without `ADMIN_API_SIGNING_KEY`, the seed makes the
members only and says how to add the yeshiva. The keys are `seed-yeshiva-…`: a rerun finds the
institution, skips staff who are already active and replays the roster import, so it makes nothing new.
The seed signs staff tokens with the local pair only. A deployed console's key never leaves its
secret store.

### Not seeded: the contract cannot make these yet

| Who | Recordings | Why |
|---|---|---|
| Funder linked to a member (Ben to Dana) | REC-01 funder mode, REC-04 | `POST /memberships` needs a plan in `billing.plan_version`, and no endpoint or migration creates one |
| Active roster members | REC-14, REC-15 | A roster import makes invited members, and nothing over HTTP activates them |
| Allowance schedule | REC-14 | No endpoint creates `org.allowance_schedule` |

## Sign in to the console as staff (T-0919)

The console keeps its full Identity Center sign-in: discovery, authorization code, token, JWKS. Locally,
the simulator panel answers it with a standards-shaped issuer at <http://localhost:4010/oidc>. Its
`/authorize` shows a list of staff to pick from where a password form would be. The signing key is
generated when the panel starts, and every ID token records a hardware key (`amr: ["hwk"]`), as
Identity Center would require.

| Staff | Roles |
|---|---|
| Sam Support | `support` |
| Cleo Compliance | `compliance` |
| Carl Compliance | `compliance` (the second approver for an institution's payout account) |
| Finn Finance | `finance` |
| Fern Finance | `finance` (the second approver for institution deposits) |
| Ada Admin | `admin` |
| Abe Admin | `admin` (the second approver for two-person flag flips) |

The console signs 5-minute staff tokens for the API with its own key. The API trusts that key's public
half through `STAFF_JWKS`. Make a local pair once. It lands in `.env.local-staff`, which git ignores:

```sh
cd apps/demo && node --input-type=module -e "import {generateKeyPair,exportJWK} from 'jose'; const k = await generateKeyPair('ES256', {extractable: true}); console.log(\"STAFF_JWKS='\" + JSON.stringify({keys: [{...await exportJWK(k.publicKey), kid: 'local-staff-1', alg: 'ES256', use: 'sig'}]}) + \"'\"); console.log(\"ADMIN_API_SIGNING_KEY='\" + JSON.stringify(await exportJWK(k.privateKey)) + \"'\");" > ../../.env.local-staff && cd ../..
```

Start the demo stack with `STAFF_JWKS` from that file, then the console against it:

```sh
set -a; . ./.env.local-staff; set +a
APP_ENV=development DATABASE_URL="postgres://postgres:postgres@localhost:5433/club" pnpm --filter @kesher/demo dev
# in a second terminal, after `set -a; . ./.env.local-staff; set +a`
NODE_ENV=development ADMIN_ENVIRONMENT=local ADMIN_BASE_URL=http://localhost:3100 ADMIN_VPN_CIDRS=127.0.0.0/8,::1/128 \
ADMIN_OIDC_ISSUER=http://localhost:4010/oidc ADMIN_OIDC_JWKS_URL=http://localhost:4010/oidc/jwks \
ADMIN_OIDC_CLIENT_ID=kesher-admin-local ADMIN_OIDC_AUDIENCE=kesher-admin-local ADMIN_OIDC_CLIENT_SECRET=local-simulator-client \
ADMIN_DATA=api ADMIN_API_URL_IL=http://localhost:3000/v1 ADMIN_API_URL_US=http://localhost:3000/v1 ADMIN_API_SIGNING_KID=local-staff-1 \
pnpm --filter @kesher/admin exec next dev -p 3100
```

Open <http://localhost:3100>, choose "Sign in with Identity Center", and pick the staff member.
`kesher-admin-local` / `local-simulator-client` is the simulator issuer's client. It is not a secret: the
issuer answers only to a request addressed to this machine (`localhost`, `127.0.0.0/8` or `::1`) and
redirects only back to it.

The console's config allows this issuer for `ADMIN_ENVIRONMENT=local` only. Outside `local`,
`ADMIN_OIDC_ISSUER` and `ADMIN_OIDC_JWKS_URL` must be `https` and must not name this machine. In `local`,
plain `http` is allowed only for this machine.

The console's flag page shows the database's flags, not the demo's in-memory "all on". Flipping one there
changes the stored flag, which the demo process does not read.

The member app in a browser (T-0033) builds on this stack too: see `apps/mobile/README.md`.

## Record the walkthroughs (T-0920)

The bank-review walkthroughs are recorded from the running product, by the browser itself. Nothing outside
the page is captured. One command starts its own stack, the member app's web build and the console, seeds
the personas, and records:

```sh
pnpm --filter @kesher/demo record --grep "REC-0[1-5]"
```

Each recording is one page with three panes: the member app, the simulator panel (the vendor's side and the
clock), and the console's Customer 360. Every spec asserts that the amounts on screen and in Customer 360
equal the worked example in `docs/bank-review/money-flows.md`, in minor units, so a recording cannot pass while
showing a wrong number. The videos land in `apps/demo/out/REC-NN-<name>.webm`, which git ignores.

- Ports 3000, 3100, 4010, 4099 and 8081 must be free: the run starts its own servers and never reuses one.
- The run makes its own staff key pair; nothing from `.env.local-staff` is read.
- A step with no member screen is shown as an API caption ("API: POST …"), never as a screen.
- The panel's `POST /jobs/{name}/run` runs one of the stack's jobs now, at the panel clock, so a recording
  shows a release or an auto-reload without waiting for the job's timer.
