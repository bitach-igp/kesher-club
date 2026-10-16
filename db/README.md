# db

Forward-only Postgres migrations managed by [Atlas](https://atlasgo.io), one directory per schema,
plus the roles every environment needs. Rules come from the constitution (art. 3, 6, 9) and the
`club-ddl` skill in `.claude/skills/club-ddl`.

| Path | What |
|---|---|
| `roles.sql` | `club_migrator`, `club_app`, `club_jit`, `club_readonly`. Run once as a superuser before the first migration. |
| `atlas.hcl` | Atlas envs `local`, `preview`, `staging`, `prod`; one instance per schema via `for_each`. |
| `migrations/<schema>/NNNN_slug.sql` | Versioned migrations. `ledger/0001_init.sql` is the money core. |
| `lint.mjs` | Migration lint (CI step `node db/lint.mjs`). Tests: `node --test db/`. |

## Workflow

```
export ATLAS_URL='postgres://club_migrator:…@localhost:5432/club?sslmode=disable'
psql "$ATLAS_URL" -f db/roles.sql                     # once per database, as a superuser
atlas migrate hash  --dir file://db/migrations/ledger  # after adding a file
atlas migrate lint  --env local --latest 1             # destructive-change check against a Docker dev DB
atlas migrate apply --env local                        # applies every schema, in `locals.schemas` order
node db/lint.mjs                                       # house rules (bigint money, timestamptz, grants…)
```

A new migration is a new file with the next number. Never edit or delete a merged file: Atlas
checksums (`atlas.sum`) fail the build, and `lint.mjs` R8 fails on a gap.

## Expand / contract

Releases apply only **expand** migrations (additive, backwards compatible with the running code).
A **contract** step (drop column, tighten a constraint) ships one release later, after the code
stopped reading the old shape, and must carry `-- atlas:nolint destructive` with a reviewer's
name. Prod applies from CI with the `club_migrator` secret; nobody runs migrations by hand.

## Grants in one line

`club_app` may `select, insert` on `ledger.*` and `update` only `ledger.account_balance` (the
balance cache written by `post()`), `select, insert, update` on `ops.*` and `agent.*`. `club_jit`
gets `select` on ledger and cards and `insert` on `ledger.journal` / `ledger.posting` for holds.
`club_readonly` is `default_transaction_read_only`. Every migration that adds a table grants
explicitly; nothing is granted to `public`.
