# Secrets (T-0056)

Terraform creates one empty container per secret under `kesher/<env>/` in Secrets Manager (CMK-encrypted). It never holds a
value: `tfvars` carry no secrets, and the RDS master password is generated and rotated by RDS. Two ways to fill a container:

- **Generated here**: `tools/secrets` creates the key material, checks it against the shape the processes accept, and loads it.
- **From a vendor dashboard**: a person pastes it with `aws secretsmanager put-secret-value --secret-id kesher/<env>/<name> --secret-string file:///dev/stdin`
  (type or pipe the value; never put it on the command line, in a file in the repo or in a chat).

## Generate and load

Prerequisite: `envs/<env>` applied, and an AWS session whose role may read and write `kesher/<env>/*` (the deploy role).

```sh
node tools/secrets/index.mjs --env staging --region us-east-1 --dry-run     # what it would load, nothing written
node tools/secrets/index.mjs --env staging --region us-east-1               # loads the ones with no value
node tools/secrets/index.mjs --env staging --region us-east-1 --only staff-jwks,admin-api-signing-key --rotate
```

It prints one line per secret (`loaded`, `kept`, `rotated`, `would-load`, `no-container`, `failed`) and nothing else. A value
is never printed, never an argument and never logged; the AWS CLI reads it from standard input. A secret that already has a value
is kept unless `--rotate` is given. The tool never replaces `pii-data-key` or `pii-index-key` (it refuses an explicit
request and skips them under a general `--rotate`), and it treats `admin-api-signing-key` and `staff-jwks` as one key pair: it
loads, keeps or rotates both together, refuses to name only one, and stops with `pair-mismatch` when exactly one already has a
value (re-run with `--rotate` to replace both). `no-container` means Terraform has not created it: apply the environment first.

## Every container

| Name | Source | Read by | Notes |
|---|---|---|---|
| `jwt-signing-key` | generated | api, jit, worker | Private ES256 JWK (kid `kesher-<env>-1`). Signs member tokens. |
| `pii-data-key`, `pii-index-key` | generated | api, jit, worker | 32 bytes each, different from each other. Seal fields and blind-index them (T-0024). |
| `staff-jwks` | generated | api, jit, worker | Public half of `admin-api-signing-key`; the API verifies staff tokens with it (ADR-013). |
| `admin-api-signing-key` | generated | admin console | Private ES256 JWK (kid `kesher-<env>-admin-1`). Generated with `staff-jwks` from one key pair: rotate the two together. |
| `db-app-password` | generated | api, worker | `club_app`. Set on the role by the migrate task (T-0044). |
| `db-jit-password`, `db-readonly-password`, `db-migrator-password` | generated | migrate task (T-0044); jit service (T-0045) | Created by T-0044. |
| `admin-oidc-client-secret` | vendor (WorkOS or the chosen IdP) | admin console | From the IdP application for the admin SSO. |
| `stripe-api-key`, `stripe-webhook-secret` | vendor (Stripe dashboard) | api, worker | Restricted key and the endpoint signing secret. Sandbox keys in staging. |
| `provider-webhook-secrets` | vendor | api | Other providers' endpoint secrets. |
| `temporal-client-cert`, `temporal-client-key` | vendor (Temporal Cloud) | all services | Needed only once ADR-002 turns Temporal on; see decision D1 in `docs/ops/deploy-readiness.md`. |

## Webhook ingress

The webhook listener is off until `webhook_provider_cidrs` lists the provider's published egress ranges (`infra/terraform/envs/<env>/variables.tf`).
Take the ranges from the provider's own published list at the time you apply, put the source and the date in the pull request, and
re-check them at every webhook-secret rotation. An empty list keeps the listener closed.

## Rotation

| Secret | Procedure |
|---|---|
| Database passwords | `--rotate` the four `db-*` secrets, then run the migrate task (T-0044): it sets the new passwords on the roles. Restart the services (a deploy does it) so they pick the new `db-app-password` up. |
| `jwt-signing-key` | The API holds one signing key (`apps/api/src/auth/tokens.ts`): tokens signed with the old key stop verifying the moment the new key is live. Access tokens last 10 minutes and the app refreshes on a 401, so members do not sign in again, but rotate off-peak and expect a burst of refreshes. A two-key overlap is a future card. |
| `admin-api-signing-key` and `staff-jwks` | The tool rotates the pair as one (`--only staff-jwks,admin-api-signing-key --rotate`). The key id stays `kesher-<env>-admin-1`, so deploy the API and the console in the same release: until both run, staff tokens fail to verify. |
| `pii-data-key`, `pii-index-key` | The tool refuses to rotate them. Sealed columns and blind indexes were written with the old keys; a rotation needs a re-seal job that reads with the old key and writes with the new one. That job is not built: open a card when the first rotation is due. |
| Vendor secrets | Rotate in the vendor dashboard. Stripe and other webhook secrets allow two values during the overlap (the config takes `old,new` comma-separated), so deliveries keep verifying while the vendor switches. |

If a secret may have been exposed, treat it as RUN-07 (data incident): rotate it first, then work out how it leaked.
