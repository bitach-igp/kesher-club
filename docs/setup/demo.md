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

Seed personas (T-0032), the member app in a browser (T-0033) and staff sign-in to the console (T-0919)
build on this.
