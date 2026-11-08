# Deploying an environment (T-0050)

`.github/workflows/deploy.yml` rolls one release tag onto staging or prod. Run it from `main` (Actions tab, deploy, Run workflow, "Use workflow from: main"):

```sh
gh workflow run deploy.yml --repo bitach-igp/kesher-club --ref main -f environment=staging -f image_tag=sha-0123456789ab
```

`image_tag` is the tag `release.yml` printed (`sha-` and 12 lowercase hex characters); anything else is refused before AWS is touched. The infrastructure code
that is applied is `main`'s, the images are the tag's: deploying an older tag runs old images on today's Terraform, which is what a rollback is.

## What a run does

The decisions are small scripts in `tools/release/deploy/` that the workflow calls and `tools/release/deploy-workflow.test.mjs` runs against a stub `aws`.

| # | Job / step | What |
|---|---|---|
| 1 | `verify` | The tag is valid, the run is from `main`, and `kesher/{api,worker,admin,console,migrate}:<tag>` all exist in club-shared's ECR. One missing image fails the run. |
| 2 | prod gate (prod only, `prod-gate.sh`) | Still in `verify`, so a tag that has not soaked never asks the reviewers to approve. The tag must be one staging has run, **alone**, for an hour: staging has no `/kesher/staging/deploy-in-progress` marker, `/kesher/staging/deployed-image-tag` names this tag, and that parameter was last written at least 3600 seconds ago (its own `LastModifiedDate`). All reads go through the staging deploy role; any read error other than "no such parameter" (AccessDenied...) fails the gate. One exception, for rollback: a tag in the history of prod's own `deployed-image-tag` (written only after a deploy passed its smoke suite) needs no staging soak. |
| 3 | `deploy` starts | Runs on the GitHub environment `staging` or `prod`. For prod, GitHub holds the job until the environment's required reviewers approve and its wait timer ends. The prod gate runs again, now that they have, because staging may have moved meanwhile. |
| 4 | credentials | The CI role through GitHub OIDC (subject `environment:<name>`), no access key anywhere. Terraform's providers then assume `kesher-deploy` in the environment's account. The AWS CLI steps use a profile chained to the same deploy role (`--profile deploy`). |
| 5 | checks | Secrets and variables are present (`PAGER_ENDPOINT` must be an `https://` URL on **both** environments: the roots take `pager_endpoint` with no default and `modules/alarms` requires https). `check-account.sh` then proves that Terraform's account (`account_id` and `shared_account_id` in `TERRAFORM_VARS`), the CLI's `deploy` profile (built from `AWS_*_ACCOUNT_ID`) and the repository variables all name the same accounts, before anything changes. |
| 6 | previous tag, in-progress mark | `/kesher/<env>/deployed-image-tag` is read (`none` on a first deploy), then `/kesher/<env>/deploy-in-progress` is set to the tag. The mark stays if the deploy dies and is cleared only by the success record, so a record left by an earlier success is not trusted while a later deploy is unsettled. |
| 7 | `terraform init`, migrate plan | A plan limited to `module.migrate` (`-target`), written to the job summary. `check-plan.sh` reads it as JSON and fails if it changes anything outside the module. |
| 8 | migrate apply and run | The targeted plan is applied (a new revision of the migrate task definition, running `kesher/migrate:<tag>`), then `run-migrate.sh` verifies that revision runs the tag, starts it with `aws ecs run-task` and the network configuration from `terraform output migrate_task`, and waits (30 minutes at most). It **fails the deploy unless the container exits 0**. A failed `describe-tasks` is retried five times; if the script ends for any reason before the task stopped (polling gave up, the deadline, a cancelled run) it stops the task, so a re-run never starts a second migration beside a first. No service has been touched yet. |
| 9 | whole-root plan and apply | Planned after step 8, so the saved plan is not stale; shown in the job summary; the saved plan (`-out`) is what is applied, with no `-auto-approve`. This is the step that rolls the services. |
| 10 | stability | `check-services.sh`: `aws ecs wait services-stable` for each service in `terraform output ecs_service_names` (api, jit and worker per market, admin, console), then each service must have a single `COMPLETED` deployment whose task definition runs only images ending in the tag. The wait alone is not enough: the circuit breaker in `modules/ecs-service` rolls a failed task set back, and a rolled-back service is "stable" too. |
| 11 | smoke | `tools/smoke/index.mjs` for each market (the non-strict command in the next section; admin and the portal once, with the IL market), with `--expected-tag`. On failure the run fails and the message names the previous tag (or says there is none to roll back to). |
| 12 | record | Only when everything above passed: `aws ssm put-parameter --overwrite` writes `/kesher/<env>/deployed-image-tag` (the tag) and `/kesher/<env>/deployed-at` (UTC time), then the in-progress mark is deleted. |

A failure after step 9 ends with a summary that names the previous tag and how to roll back. A failure before it ends with "nothing rolled": the services were not applied, so there is nothing to roll back.

### Sessions

A role assumed from OIDC lasts an hour, and the CLI deploy-role profile is chained from it and cannot outlive it. The workflow therefore takes a new OIDC session before the migration, before the whole-root plan and apply, and before the service wait; each stretch (the migration is capped at 30 minutes) fits in one. A single stability wait is capped at 10 minutes per service by the CLI waiter.

## Why migrate first, and how the order is enforced

One `terraform apply` creates the new migrate task definition and rolls the services in the same run, and Terraform gives no way to run a task between two
resources of one apply. Two applies are needed, and the first must be unable to roll a service. So the migration is a **targeted apply of `module.migrate`**
(its task definition is the only thing that changes with the tag), then the task runs, then the whole root is planned and applied. Choices:

- The targeted plan is saved and applied as a plan, and its JSON is checked: any change to a resource outside `module.migrate.` fails the run before apply. A targeted
  apply is otherwise how a service could roll early, so the check is what makes the order a guarantee. If it trips (for example, a change to the secrets or network
  that the migrate module depends on is waiting on `main`), apply that change by hand first (`infra/terraform/README.md`), then run the workflow again.
- The whole-root plan is made after the targeted apply, because a plan saved before it would be stale and Terraform would refuse it.
- The migrate task runs the exact task definition revision it just verified (`kesher/migrate:<tag>`), not "the latest".
- If the migration fails, no service has rolled; the schema may be partly ahead, which is safe: the steps are idempotent and re-runnable (`docs/setup/database.md`), and
  migrations are expand-only (`db/README.md`), so the running (old) services keep working on it.
- If a later step fails, the newer schema stays. Old and new images both run on it for the same reason.

The first apply of an environment (the Organization-created role, secrets not yet loaded, no ECS cluster) is not a deploy: do it by hand per `infra/terraform/README.md`.
This workflow needs the environment to exist, including the `migrate_task` and `ecs_service_names` outputs (the latter is added to the state by the first apply after T-0050).

## Roll back

Rolling back is the same workflow with the previous tag: environment `<env>`, `image_tag` = the tag the failed run printed (or read it:
`aws ssm get-parameter --name /kesher/<env>/deployed-image-tag`; older values: `aws ssm get-parameter-history --name /kesher/<env>/deployed-image-tag`).
The migrate task runs again (nothing to do, it is idempotent), the services roll back to the old images, smoke runs. Migrations are expand-only, so the old
image runs on the newer schema; a **contract** migration ships one release after the code stopped reading the old shape, which is what keeps this true. Prod accepts the
old tag without a new staging soak because prod already ran it (step 2). If a deploy was stopped halfway by the circuit breaker, the services already
rolled themselves back; deploy again with the previous tag to make the SSM record and the Terraform state agree.

## Human steps (once)

These need an owner or admin; the workflow cannot do them. Nothing was verified against AWS or GitHub when the workflow was written.

1. **GitHub environments** (Settings, Environments). Create `staging` and `prod`. On both, restrict deployment branches to `main`.
   On `prod`: **Required reviewers** (at least two people other than whoever starts the run; enable "Prevent self-review") and a **Wait timer** (for example 30 minutes, the
   window to read the posted plan of a staging deploy and cancel). Staging has no reviewers.
2. **Repository variables** (Settings, Secrets and variables, Actions): `AWS_CI_ROLE_ARN`, `AWS_SHARED_ACCOUNT_ID`, `AWS_STAGING_ACCOUNT_ID` (all from `docs/setup/release.md`) and
   **`AWS_PROD_ACCOUNT_ID`**, new: `terraform output -json member_account_ids | jq -r .prod` in `envs/shared`.
3. **Environment variable `TERRAFORM_VARS`** on each GitHub environment: the root's required Terraform variables as HCL, one per line, no secrets
   (`account_id`, `shared_account_id`, `hosted_zone_id`, `ecr_registry`, `locked_backup_vault_arn`, `temporal_address`, `temporal_namespace`, `admin_oidc_issuer`,
   `admin_oidc_client_id`, `admin_oidc_jwks_url`, and any default you override, such as `domain`). The workflow writes it to `deploy.auto.tfvars`; `image_tag` is passed on the command line and wins.
4. **Environment secret `PAGER_ENDPOINT`** on **both** `staging` and `prod`: the pager integration's `https://` URL (both roots take `pager_endpoint` with no default and `modules/alarms` requires https). The workflow passes it as `TF_VAR_pager_endpoint` and refuses to start without it.
5. **Deploy roles.** `kesher-deploy` exists in each member account once the root was applied by hand (it is `PowerUserAccess` plus IAM on `kesher-*` roles, so it already may
   `ssm:PutParameter` on `/kesher/<env>/*`, run ECS tasks and pass the migrate execution role). This card changes no IAM. **Know what that means: the GitHub
   required reviewers, the wait timer and the staging soak gate are not enforced in AWS today.** `modules/oidc` lets `main`, `pull_request`, `environment:staging` and
   `environment:prod` all assume ONE CI role, and that role may assume every deploy role, prod's included; so any workflow in this repository (a pull request's too) can reach
   the prod deploy role without passing through the `prod` environment. The gates protect the path this workflow offers, not the account. Card T-0070 closes it (per-environment
   CI roles or deploy-role trust on the OIDC subject, so prod is reachable only from the `prod` environment job). Until then treat write access to the repository as access to prod.
6. Actions minutes (a run with none fails every job at once).

## Not covered

- The workflow checks that the images exist, not that the release's scan gate passed (the image tags are immutable and a failed gate leaves its image in ECR).
  Deploy only a tag whose `release.yml` run is green.
- Blue/green traffic shifting. Services roll in place (min 100 percent, max 200 percent) behind the circuit breaker.
- `--strict` smoke: see the next section.
- A stale `deploy-in-progress` mark (a deploy that died) blocks the prod gate on staging until a staging deploy succeeds; delete the parameter only after checking what state staging is in.
- Credentials: see Sessions above.

## Smoke test of a deployed environment

`tools/smoke` (T-0051) answers one question after a deploy: does this environment work. It is plain Node (22 or later, no install step).
It talks to the environment over HTTPS only, sends GET, HEAD and deliberately invalid requests, and never creates data. It stops at the
first failure, names the check and exits 1.

### Run it

A command that can pass today (the tag and OpenAPI checks skip, and the console check is left out until a console image is deployed: it serves `/healthz` since T-0047):

```sh
node tools/smoke/index.mjs \
  --base-url https://api-il.staging.<domain> \
  --jit-url https://jit-il.staging.<domain> \
  --admin-url https://admin.staging.<domain> \
  --web-url https://app.staging.<domain>
```

The strict gate the card aims at, which **cannot pass today**:

```sh
node tools/smoke/index.mjs --strict \
  --base-url https://api-il.staging.<domain> --jit-url https://jit-il.staging.<domain> \
  --admin-url https://admin.staging.<domain> --console-url https://console.staging.<domain> \
  --web-url https://app.staging.<domain> --openapi-url https://api-il.staging.<domain>/<openapi path> \
  --expected-tag sha-0123456789ab
```

It fails today for two reasons, each a follow-up: `api-tag` skips because the API reports no deployed tag; and `openapi-operations`
has no document to read because the API serves none. `console-healthz` passes once the console image from T-0047 is deployed.
`webhook-bad-signature` also skips (so fails under `--strict`) while the flag `institutions.usBanking` is off, which is its default.
Do not wire `--strict` into a deploy gate until those land.

`--base-url` is the API host and is the only required option. Every option has an environment variable, and a flag wins over it:

| Option | Variable | Meaning |
|---|---|---|
| `--base-url` | `SMOKE_BASE_URL` | the API host (`https://` origin) |
| `--jit-url` | `SMOKE_JIT_URL` | the card-authorisation host |
| `--admin-url` | `SMOKE_ADMIN_URL` | the admin host, tried from outside the VPN |
| `--console-url` | `SMOKE_CONSOLE_URL` | the institution console host |
| `--web-url` | `SMOKE_WEB_URL` | the parent portal host |
| `--openapi-url` | `SMOKE_OPENAPI_URL` | where the environment serves its OpenAPI document |
| `--expected-tag` | `SMOKE_EXPECTED_TAG` | the image tag the deploy just rolled out (`sha-<12 characters>`, `docs/setup/release.md`) |
| `--webhook-path` | `SMOKE_WEBHOOK_PATH` | the webhook route used for the bad-signature check, default `/v1/webhooks/crowded` |
| `--strict` | `SMOKE_STRICT=1` | a skipped check counts as a failure |
| `--allow-local` | `SMOKE_ALLOW_LOCAL=1` | accept `http://` for localhost, 127.0.0.1 and [::1] only (the unit tests; a developer's machine) |

Output is one line per check, `PASS`, `SKIP` or `FAIL`, then a summary. `http://` is refused for every other host, as are URLs with a
user name or password. A check whose URL was not given is skipped. `--strict` and every URL stop a skipped check from hiding a missing host. Run it from outside the VPN: the admin check needs that to mean anything. The TLS check connects
directly with `node:tls` and does not go through an HTTP proxy.

### The checks

| Check | What it does | What a pass means |
|---|---|---|
| `api-status` | `GET /v1/status` on the API host | 200, and the five capabilities (`wallet`, `card`, `p2p`, `fx`, `payouts`) each read `ok`, `degraded` or `off`. A flag that is off is not a failure; a broken body or a non-200 is. |
| `api-tag` | compares `--expected-tag` with the tag the API reports | the running build is the one just deployed. See Deviations: the API reports none today. |
| `openapi-operations` | fetches `--openapi-url` and counts operations (paths times methods) | the served document has as many operations as `contracts/openapi.yaml` in this checkout. Run it from the commit that was deployed. |
| `api-tls13-only` | `node:tls` handshake with `maxVersion: TLSv1.2`, then with `minVersion: TLSv1.3` | TLS 1.2 is refused with a protocol-version alert and TLS 1.3 is negotiated on the API host. Any other error on the first handshake (DNS, connect, certificate) is a failure: it does not show TLS 1.2 is refused. |
| `jit-health` | `GET /v1/status` on the JIT host | 200 with `{"role":"jit","status":"ok"}`: the process is the authorisation role, not a second API. |
| `admin-closed-outside-vpn` | resolves the admin host, then `GET /` | the name resolves, and the answer is 403, a refused or reset connection, or a timeout. A name that does not resolve, any other status (2xx, a redirect, 401, 404, 5xx) or any other error fails: only an explicit refusal proves the door is shut. |
| `console-healthz` | `GET /healthz` on the console host | 200. |
| `web-security-headers` | `GET /` on the web host | `Strict-Transport-Security` with max-age of at least 15552000 (180 days); `X-Content-Type-Options: nosniff`; frame protection (`X-Frame-Options` DENY or SAMEORIGIN, or a CSP `frame-ancestors`); a `Content-Security-Policy` header. A failure lists every missing one. The list is the floor for a site that serves pages; it does not judge the CSP's content. |
| `webhook-bad-signature` | POSTs one forged delivery (a wrong signature) to `--webhook-path`, after checking the path stays on the API origin | exactly 401 with problem code `invalid_signature`. A 404 (the route sits behind the flag `institutions.usBanking`, default off, and answers `FEATURE_OFF` before it looks at the signature; or the path is wrong) is a SKIP, because no refusal was proven. A 2xx or any other answer fails. That a refused delivery claims no event id (T-0207) is not visible from outside and is proved by the API's own tests, not here. |
| `money-route-needs-auth` | `GET /v1/accounts` with no bearer | 401. |

### What it can and cannot do to the environment

- The client has no PUT, PATCH or DELETE. A POST goes through one function reserved for invalid requests, and `smoke.test.mjs` records
  every request the suite makes and fails on anything else.
- It sends no credential: the client refuses an `Authorization`, `Cookie`, `X-Api-Key` or similar header, so nothing it sends can authenticate.
- The forged webhook is the one request with a side effect, and only when the route is live (flag on): the API keeps a record of
  the refused delivery for forensics (`ops.inbound_rejected`: a hash, never the body). It is not an event and moves no money.
  With the flag off the route answers 404 and stores nothing.

### Deviations from the card (T-0051)

- **The API reports no deployed tag.** `GET /v1/status` returns the capabilities and an optional incident only, and nothing sets a
  version header. `apps/api` is outside the card's files, so the tag check reads `x-kesher-version` or a `version` or `tag` field in the
  status body if the API ever sends one, and otherwise SKIPs with that message (a failure under `--strict`). A follow-up should
  have the API return its `IMAGE_TAG`.
- **The API serves no OpenAPI document.** The same reasoning: `openapi-operations` needs `--openapi-url`, and skips without it.
- **The console serves `/healthz`** (T-0047: 200 only when `CONSOLE_ENVIRONMENT` and `CONSOLE_API_URL` are valid), so `console-healthz` passes against a deployed console image.
