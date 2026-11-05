# Preparing a deployed database (T-0044)

The RDS instance of staging and prod is in isolated subnets: nothing outside the VPC reaches it, so nobody applies
migrations from a laptop or a GitHub runner. A one-off Fargate task does it, from the `kesher/migrate` image
(`tools/migrate/Dockerfile`; `release.yml` builds it with api, worker and admin). It runs `db/prepare.mjs`, three steps,
each safe to repeat:

| Step | As | What |
|---|---|---|
| `roles` | RDS master user (managed secret) | `db/roles.sql`: `club_migrator`, `club_app`, `club_jit`, `club_readonly`, the statement budgets |
| `passwords and grants` | RDS master user | the four roles' passwords from Secrets Manager; `CONNECT` on the database for all four and `CREATE` for `club_migrator` (`roles.sql` revokes `CONNECT` from PUBLIC and grants it to nobody, so without this step no service could log in and the migrator could not create a schema) |
| `migrate` | `club_migrator` | `db/migrate.mjs`: every schema in dependency order with Atlas (pinned 1.3.8 in the image) |

No password is an argument, a statement or a log line: psql reads each one from its environment (`\getenv`) and the
migrator's URL travels in `ATLAS_URL`. A missing key stops the task before anything runs and names itself.

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
  --network-configuration "awsvpcConfiguration={subnets=[<subnets>],securityGroups=[<security_group>],assignPublicIp=DISABLED}"
```

The task's log group is `/kesher/kesher-<env>-migrate`. It prints `ok   <step>` per step and exits non-zero on the first
failure (`FAIL <step>`); psql and Atlas print their own errors, never a password.

## Rules that still hold

- Releases apply only expand migrations; a contract step ships one release later (`db/README.md`).
- Re-running is the recovery for a half-finished run: each step is idempotent and Atlas never re-applies a file.
- Changing a role's grants is a new migration, not an edit of `roles.sql` on a live database.
