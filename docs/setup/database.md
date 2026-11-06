# Preparing a deployed database (T-0044)

The RDS instance of staging and prod is in isolated subnets: nothing outside the VPC reaches it, so nobody applies
migrations from a laptop or a GitHub runner. A one-off Fargate task does it, from the `kesher/migrate` image
(`tools/migrate/Dockerfile`; `release.yml` builds it with api, worker and admin). It runs `db/prepare.mjs`, three steps,
each safe to repeat:

| Step | As | What |
|---|---|---|
| `roles` | RDS master user (managed secret) | `db/roles.sql`: `club_migrator`, `club_app`, `club_jit`, `club_readonly`, the statement budgets. First the master is made an inheriting member of `club_migrator` (`set false`, skipped for a superuser or when already granted): `roles.sql` alters that role's default privileges, which Postgres 16 refuses to a CREATEROLE master that only holds ADMIN on it |
| `passwords and grants` | RDS master user | the four roles' passwords from Secrets Manager; `CONNECT` on the database for all four and `CREATE` for `club_migrator` (`roles.sql` revokes `CONNECT` from PUBLIC and grants it to nobody, so without this step no service could log in and the migrator could not create a schema) |
| `migrate` | `club_migrator` | `db/migrate.mjs`: every schema in dependency order with Atlas (pinned 1.3.8 in the image) |

No password is printed, written into a statement or given to psql as an argument: psql reads each one from its environment
(`\getenv`). The one place a password is an argument is `atlas migrate apply --url`, because the migrator's password is part of
its connection URL; that process lives only inside the task's container, and Atlas does not print it. Each step is given only the
variables it needs (the migration step never sees the master credentials or the other roles' passwords). A missing key stops the
task before anything runs and names itself.

Known residual: Postgres logs a statement that fails with `log_min_error_statement` (default `error`), and `ALTER ROLE … PASSWORD`
carries the literal. It can only fail if a role is missing, which step 1 prevents. If you ever see that step fail, treat the
database log as holding that password and rotate it.

## Secrets

Terraform creates the containers; a person loads the values once, before the first run (`infra/terraform/README.md`
step 5, and the generator tool of T-0056 when it lands). Four passwords, each a long random string:

| Secret (`kesher/<env>/…`) | Used by |
|---|---|
| `db-app-password` | the api and worker services (`club_app`) |
| `db-jit-password` | the JIT service (`club_jit`, wired by T-0045) |
| `db-readonly-password` | reporting (`club_readonly`) |
| `db-migrator-password` | this task only (`club_migrator`) |

The RDS master secret is created and rotated by RDS; the task reads it directly.

## Run it

`terraform output migrate_task` in `envs/staging` or `envs/prod` gives everything the call needs. The deploy workflow
(T-0050) runs this before it rolls the services; to run it by hand, as the deploy role:

```sh
aws ecs run-task --cluster <cluster> --task-definition <task_definition> --launch-type FARGATE \
  --network-configuration '{"awsvpcConfiguration":{"subnets":[<subnets>],"securityGroups":[<security_groups>],"assignPublicIp":"DISABLED"}}'
```

The task's log group is `/kesher/kesher-<env>-migrate`. It prints `ok   <step>` per step and exits non-zero on the first
failure (`FAIL <step>`); psql and Atlas print their own errors, never a password.

## Rules that still hold

- Releases apply only expand migrations; a contract step ships one release later (`db/README.md`).
- Re-running is the recovery for a half-finished run: each step is idempotent and Atlas never re-applies a file.
- Changing a role's grants is a new migration, not an edit of `roles.sql` on a live database.
