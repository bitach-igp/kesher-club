# infra/preview — preview environment per pull request (T-0010)

One Terraform root, applied once per PR by `.github/workflows/preview.yml`, that stands up on the
**staging** cluster:

| Piece | What |
|---|---|
| `api` service | 1 Fargate task (0.5 vCPU / 1 GB) on this PR's `kesher/api:pr-<n>-<sha>` image |
| `worker` service | 1 task on `kesher/worker:pr-<n>-<sha>`; Temporal task queues prefixed `preview-<n>` |
| Database | `preview_<n>` on the shared staging RDS instance, owned by `club_app`, dropped on close |
| Hostname | `preview-<n>.staging.kesher.example` → staging ALB, host-header rule priority `1000 + n` |
| Providers | `PROVIDER_MODE_DEFAULT=sim`: every port binds to its simulator |

Each PR has its own state object (`preview/pr-<n>.tfstate`) in the shared state bucket. The root
reuses `infra/terraform/modules/ecs-service` unchanged and reads every staging fact (cluster,
listener, RDS address, secret ARNs, …) from the SSM parameters `envs/staging` exports under
`/kesher/staging/preview/`, so previews never open the staging state file.

## Why the database is created by an ECS task and not the `postgresql` provider

Three options were considered:

1. **`cyrilgdn/postgresql` provider** — declarative and tidy, but the provider connects from
   wherever `terraform apply` runs. The staging RDS instance has no public endpoint and lives in
   isolated subnets, so a GitHub runner cannot reach it without a bastion, VPN or self-hosted
   runner inside the VPC. Adding any of those just for previews widens the database's attack
   surface (spec §9: RDS in private subnets, no 0.0.0.0/0).
2. **Neon-style branch** — would mean a second database vendor for previews only, with a schema
   that may drift from RDS Postgres 16; the spec names RDS as the database.
3. **A one-off Fargate task running `psql`** (chosen) — `scripts/preview-db.sh` runs the staging
   `db-tool` task definition (official `postgres:16-alpine` image) in the private subnets with the
   RDS-managed master secret injected by ECS. The runner only calls `ecs:RunTask` and waits. No
   database credential ever reaches the runner, the Terraform state or a log line. A
   `null_resource` with a destroy-time provisioner drops the database `WITH (FORCE)` on PR close.
   The create step is idempotent (`WHERE NOT EXISTS … \gexec`), so a re-run after a failed apply
   is safe.

## How the app gets its database password

`DATABASE_URL` is `postgres://club_app@<host>:5432/preview_<n>?sslmode=require` with **no
password**. `PGPASSWORD` is injected by the ECS secrets integration from the staging secret
`kesher/staging/db-app-password`. node-postgres and libpq both fall back to `PGPASSWORD` when the
URL carries none, so the password stays in Secrets Manager only.

Assumptions on the application side (owned by other task cards):

- `club_app` exists on the staging instance with its password in that secret (T-0005 roles).
- The api/worker images run migrations on boot when `MIGRATE_ON_BOOT=true` (T-0005 tooling).
- `apps/api/Dockerfile` and `apps/worker/Dockerfile` build the two images; the api exposes
  `GET /healthz` on port 3000 and serves the OpenAPI paths under `/v1`.
- The worker honours `TEMPORAL_TASK_QUEUE_PREFIX` so previews share the staging namespace
  without stealing each other's work.

## GitHub configuration

Repository **variables** (not secrets; the OIDC role is the only credential):

| Variable | Value |
|---|---|
| `AWS_CI_ROLE_ARN` | `ci_role_arn` output of `infra/terraform/envs/shared` |
| `AWS_SHARED_ACCOUNT_ID` | club-shared account id |
| `AWS_STAGING_ACCOUNT_ID` | `member_account_ids.staging` output of `envs/shared` |

The workflow runs on `pull_request` `opened` / `synchronize` / `reopened` (build, apply, comment,
Schemathesis) and `closed` (destroy, delete the state object). Fork PRs are skipped because they
cannot mint an OIDC token. One concurrency group per PR serialises applies and never cancels an
apply mid-flight (a cancelled apply would leave the state lock held).

## Running it by hand

```
cd infra/preview
terraform init -backend-config=backend.hcl -backend-config="key=preview/pr-123.tfstate"
terraform apply -var pr_number=123 -var image_tag=pr-123-abc1234 \
  -var staging_account_id=… -var shared_account_id=…
terraform destroy …  # same vars
```

You need an Identity Center session in club-shared that may assume `kesher-deploy` in staging,
plus `aws` and `jq` on PATH for the database script.
