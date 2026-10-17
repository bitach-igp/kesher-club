# db

Forward-only Postgres migrations managed by [Atlas](https://atlasgo.io), one directory per schema,
plus the roles every environment needs. Rules come from the constitution (art. 3, 6, 9) and the
`club-ddl` skill in `.claude/skills/club-ddl`.

| Path | What |
|---|---|
| `roles.sql` | `club_migrator`, `club_app`, `club_jit`, `club_readonly`. Run once as a superuser before the first migration. |
| `atlas.hcl` | Atlas envs `local`, `preview`, `staging`, `prod`; one instance per schema via `for_each` (settings and lint policy only; apply goes through `migrate.mjs`). |
| `migrate.mjs` | Applies every schema in dependency order with the per-schema baseline (`--allow-dirty` after the first). `--docker` uses the Atlas image. Tests: `node --test db/`. |
| `migrations/<schema>/NNNN_slug.sql` | Versioned migrations. `ledger/0001_init.sql` is the money core. |
| `lint.mjs` | Migration lint: the house rules R1–R8 plus Squawk for destructive and locking changes (CI step `pnpm db:lint`). Tests: `node --test db/`. |

## Workflow

```
export ATLAS_URL='postgres://club_migrator:…@localhost:5432/club?sslmode=disable'
psql "$ATLAS_URL" -f db/roles.sql                     # once per database, as a superuser
atlas migrate hash  --dir file://db/migrations/ledger  # after adding a file
node db/migrate.mjs --url "$ATLAS_URL"                 # applies every schema in dependency order
node db/migrate.mjs --url "$ATLAS_URL" --dry-run       # shows what each schema would apply
node db/lint.mjs                                       # house rules (bigint money, timestamptz, grants…) + Squawk
```

Why a runner and not `atlas migrate apply --env local`: Atlas runs `for_each` envs in alphabetical
order, so `addons` ran before `ledger` and failed on the missing schema. The schemas also share one
database, and Atlas refuses a "dirty" database the first time it sees a directory, so every schema
after `ledger` is applied with `--allow-dirty`. `--docker` runs `arigaio/atlas` with the repo mounted
for machines without an Atlas binary.

## Safety lint (T-0012)

`atlas migrate lint` is Atlas Pro only since v0.38, so `lint.mjs` runs [Squawk](https://squawkhq.com)
(pinned `squawk-cli`, through `npx`) over every migration after the house rules. Squawk fails the PR on
destructive and locking statements: `drop table` / `drop column`, `set not null`, renames, column
type changes, and a non-concurrent index on an existing table. `--assume-in-transaction` matches how
Atlas applies each file. Exclusions, each with its reason, live in `SQUAWK` in `lint.mjs`:

| Excluded | Why |
|---|---|
| `prefer-robust-stmts` | Atlas runs each file in one transaction and never re-applies a file, so `IF NOT EXISTS` buys nothing. |
| `prefer-bigint-over-int` | Money is already `bigint` by rule R3; counters and attempt columns stay `int`. |
| `require-statement-timeout`, `require-lock-timeout` | Pre-launch with no live traffic; revisit with the first migration against a live table. |
| `ban-char-field` | `char(3)` ISO currency codes are intentional (`ledger.currency`). |
| path `ledger/0003_transfers.sql` | Applied pre-launch; its index on a 0001 table had no live rows to lock. |

A statement that must break a rule carries `-- squawk-ignore <rule>` on the line before it, with the
reason in a comment (0005 drops `ledger.account_balance`: pre-launch, no live data; the cache is
rebuilt from postings).

A new migration is a new file with the next number. Never edit or delete a merged file: Atlas
checksums (`atlas.sum`) fail the build, and `lint.mjs` R8 fails on a gap.

## Expand / contract

Releases apply only **expand** migrations (additive, backwards compatible with the running code).
A **contract** step (drop column, tighten a constraint) ships one release later, after the code
stopped reading the old shape, and must carry `-- atlas:nolint destructive` with a reviewer's
name. Prod applies from CI with the `club_migrator` secret; nobody runs migrations by hand.

## Grants in one line

`club_app` may `select, insert` on `ledger.*` and nothing else there (constitution art. 3, lint
rule R4); the balance cache `post()` maintains is `ops.account_balance` (T-0012), covered by its
`select, insert, update` on `ops.*` and `agent.*`. `club_jit`
gets `select` on ledger and cards and `insert` on `ledger.journal` / `ledger.posting` for holds.
`club_readonly` is `default_transaction_read_only`. Every migration that adds a table grants
explicitly; nothing is granted to `public`.
