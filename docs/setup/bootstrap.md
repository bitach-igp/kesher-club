# Production bootstrap (T-0046)

A fresh staging or production database is schema only. This one-off command creates the few rows that nothing else can
create. It only inserts what is missing, so running it twice is safe: the second run reports everything as existing and
writes nothing.

## What it does

It creates the club's **system ledger accounts**, owned by the system party, one per currency (USD and ILS):

| Kind | Read by |
|---|---|
| `fx_position` | FX, p2p send, loads, closure, card authorisation (`club_jit` cannot insert into `ledger.account`, T-0413) and settlement |
| `fee_income` | the same, plus add-on orders |
| `partner_settlement` | deposits, loads, closure, card settlement, payouts |
| `addon_payable` | add-on orders |

That is every kind the code asks `systemAccount(` / `findSystemAccount(` for, eight accounts. `suspense` is an ops case kind,
`payout_reserve` and `institution_master` are per institution (created with the institution), and nothing posts to
`interchange_income`, so none of those exist as a system account. A test lists the source and fails when the code starts
asking for a kind this list lacks. The idempotency key of each insert is the table's own key (`ledger.account`: owner, type,
currency), so a re-run, or two runs at once, change nothing, and of two racing runs exactly one reports an account as created.

It then reads, without writing, how many of the seven legal document kinds have a version and how many plans exist, and
prints them.

## What it will NOT do

- **Create the first Kesher admin.** The card asked for an invite a second admin approves (T-0924). That cannot be built
  without inventing a bypass: a Kesher admin has no database account. Staff sign in by SSO and the API verifies a token
  the admin console signs (`staff-token.ts`); the identity provider decides who is an admin. T-0924's `staff_grant` approval
  is something else: it makes a signed-up *member* staff of an *institution* (`org.staff`, `org_finance` / `org_admin`), and
  needs an existing institution and member. So `--admin-email` is required, validated and printed masked, and nothing is
  stored. The first Kesher admin is a person added in the identity provider (`infra/terraform/README.md` step 6); once they
  can sign in, every later grant already needs a second admin. Whether the club wants a stored Kesher-admin record is a
  decision for the owner and a new card.
- **Create legal documents.** `legal.document_version` has no draft state: a row is published at once and the member app
  would put placeholder text on its re-accept sheet. Legal text is counsel's, entered through the console.
- **Create plans or prices.** An empty `billing.plan` is the catalogue the A13 propose/approve flow (two finance members)
  starts from.
- Write an audit entry. `AuditService.record` locks `audit.entry` in `SHARE ROW EXCLUSIVE` mode, which `club_app` (select and
  insert) may not do; the task's log lines are the record of this one-off.
- Run in `development`, `test` or `preview` (use the demo seed there). It accepts `APP_ENV` `staging` or `prod` only;
  `production` is not a value the API's config allows either.

## Run it

Run it right after the first apply (the migrate task has run), before traffic is sent to the services. It uses the api task definition (image,
`DATABASE_URL`, `PGPASSWORD` from `db-app-password`, `APP_ENV`), so it connects as `club_app`, with a command override. The
container is named like the task family, `kesher-<env>-api-<market>`; the system accounts are not per market, run it once.

```sh
aws ecs run-task --cluster kesher-<env> --launch-type FARGATE \
  --task-definition kesher-<env>-api-il \
  --network-configuration '{"awsvpcConfiguration":{"subnets":[<private subnets>],"securityGroups":[<api security group>],"assignPublicIp":"DISABLED"}}' \
  --overrides '{"containerOverrides":[{"name":"kesher-<env>-api-il","command":["node","--experimental-strip-types","--disable-warning=ExperimentalWarning","src/bootstrap/index.ts","--admin-email","<address>"]}]}'
```

`<env>` is `staging` or `prod`. `<api security group>` is not a root output: take the security group of the api service, for example `aws ecs describe-services --cluster kesher-<env> --services kesher-<env>-api-il --query 'services[0].networkConfiguration.awsvpcConfiguration'` (subnets and security groups together), or `module.api["il"]`'s security group id in the Terraform state.

The admin address is a command argument, so it is visible unmasked in the task's overrides (`describe-tasks`), in the ECS console and in CloudTrail (`RunTask`). The command prints it only masked and stores it nowhere; treat the address as an ordinary work e-mail, not a secret.

From a checkout, `pnpm --filter @kesher/api bootstrap --admin-email <address>` runs the same file (no `--` is needed; one is tolerated). The working directory is the image's `/app/apps/api`. The task terminates by itself; it does
not start a server. A Terraform one-off task definition is not part of this card.

## Verify

1. The log group `/kesher/kesher-<env>-api-il` has one `created` line per account on the first run (eight) and `done` with
   `created: 8`. The task's stop code is `EssentialContainerExited` with exit code 0.
2. Run it again: `done` with `created: 0, existing: 8`.
3. In `psql` as `club_readonly`: `select type, currency from ledger.account where owner_party_id = '00000000-0000-7000-8000-000000000000' order by 1, 2;` shows eight rows.
4. A refused run (wrong `APP_ENV`, missing `DATABASE_URL`, missing or unknown argument) exits 1 with one `failed` line. A
   database failure prints only the error class and its code (a SQLSTATE such as `28P01`, or `ECONNREFUSED`), never its
   text. Nothing prints the database URL, the password, an argument's value or the unmasked address.
