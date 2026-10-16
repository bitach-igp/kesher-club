# infra/terraform — Kesher Club platform (T-0003, Tab 3 §9)

Three AWS accounts under one Organization, all managed here and only here. **No console changes.**
Anything not in this tree does not exist; drift is a bug to fix in HCL, not in the console. The
one exception is the break-glass role in prod, whose every use is an incident with a post-mortem.

| Account | Root | Holds |
|---|---|---|
| club-shared (Organization management) | `envs/shared` | ECR, Route 53, GitHub OIDC CI role, Organization CloudTrail, Security Hub, vault-locked backup destination, Terraform state |
| club-staging | `envs/staging` | Full stack on vendor sandboxes; hosts PR previews (`infra/preview`) |
| club-prod | `envs/prod` | Full stack at pilot sizing; CI deploys, humans break glass |

## Layout

```
bootstrap/            state bucket + lock table + CMK (local state, run once)
envs/{shared,staging,prod}/   deployable roots: main.tf variables.tf outputs.tf versions.tf backend.hcl
modules/
  network/            VPC, 3 AZ × {public, private, database} subnets, NAT, S3/Secrets/KMS/ECR/Logs endpoints,
                      flow logs, optional Client VPN (Identity Center SAML)
  rds/                Postgres 16, Multi-AZ, gp3, CMK, 35-day PITR, PI, forced TLS, managed master secret, read replica
  ecs-service/        Fargate service + task def + roles + CMK log group + SG + CPU autoscaling + ALB rule
  alb/                HTTPS-only ALB (TLS 1.3 policy), access logs, regional WAF, webhook listener with IP allow-list
  cloudfront-waf/     Private KMS S3 origin + OAC + CloudFront (TLS 1.2_2021, logging) + CLOUDFRONT WAF + security headers
  kms/                CMK with rotation, alias and service/cross-account policy
  secrets/            Secrets Manager containers (values set out of band) + read policy document
  oidc/               GitHub OIDC provider and the CI role
  log-bucket/         SSE-S3 delivery bucket for ALB / CloudFront / S3 access logs (the one non-CMK bucket)
tests/                terraform test (plan mode, mocked provider): network, rds, ecs-service
```

Sizing in `envs/prod` follows the spec: api 2 × 1 vCPU/2 GB (2–8, CPU 60 %), jit same image
(2–6), worker 2 × 0.5 vCPU/1 GB (2–6), RDS db.r7g.large Multi-AZ gp3 200 GB PITR 35 d + read
replica, web apps on CloudFront. Staging is the same shape on db.t4g.large, one NAT, no replica.

## Bootstrap order

1. **Organization management account = club-shared.** Sign in through Identity Center with an
   administrator permission set. Everything below runs from a laptop once; after that only CI
   applies.
2. `bootstrap/` with local state:
   ```
   cd bootstrap && terraform init && terraform apply -var shared_account_id=<id>
   ```
   Creates `kesher-club-tfstate`, the lock table and their CMK. Keep `terraform.tfstate` from this
   root in the team password manager; it is tiny and only ever changes here.
3. `envs/shared`:
   ```
   cd envs/shared && terraform init -backend-config=backend.hcl
   terraform apply -var shared_account_id=<id> -var github_repository=<owner/repo>
   ```
   Creates the Organization, the staging and prod accounts (root e-mails in `member_accounts`),
   the SCP, ECR, the hosted zone, the CI role, CloudTrail, Security Hub and the locked vault.
   Delegate the domain to `hosted_zone_name_servers`. Put `ci_role_arn` and the account ids into
   the GitHub repository variables `AWS_CI_ROLE_ARN`, `AWS_SHARED_ACCOUNT_ID`,
   `AWS_STAGING_ACCOUNT_ID`.
4. `envs/staging`, then `envs/prod`. The first apply in each member account assumes the
   Organizations-created role, because the `kesher-deploy` role is created by that apply:
   ```
   terraform init -backend-config=backend.hcl
   terraform apply -var assume_role_name=OrganizationAccountAccessRole \
     -var account_id=<member id> -var shared_account_id=<id> -var hosted_zone_id=<zone> \
     -var ecr_registry=<id>.dkr.ecr.us-east-1.amazonaws.com -var image_tag=<sha> \
     -var locked_backup_vault_arn=<from shared> -var temporal_address=<…> -var temporal_namespace=<…>
   ```
   Later applies (and all CI applies) use the default `kesher-deploy`, which the CI role may
   assume. Prod additionally takes `break_glass_principal_arns`.
5. Set secret values. Terraform creates only the containers under `kesher/<env>/…`; load each with
   `aws secretsmanager put-secret-value` from the vendor dashboard. `tfvars` never hold secrets
   and the RDS master password is generated and rotated by RDS itself.
6. Client VPN: create the Identity Center application for the VPN, paste its SAML metadata into
   `identity_center_saml_metadata`, re-apply. The admin app is reachable only through the VPN
   (internal ALB in private subnets).

Webhook ingress is switched on by setting `webhook_provider_cidrs` to the provider's published
egress ranges; it gets its own listener on 8443 whose security group admits only those ranges, plus
a WAF rule that blocks `/webhooks/*` from anything else.

## How CI deploys

`aws-actions/configure-aws-credentials` assumes the CI role in club-shared via GitHub OIDC
(`repo:<owner/repo>:ref:refs/heads/main`, `pull_request`, `environment:staging|prod`). Terraform's
providers then assume `kesher-deploy` in the target account; the backend and Route 53 use the CI
role directly. No access key exists anywhere.

## Security gates

- `tfsec` runs on this directory in `ci.yml`. The tree is clean; every `#tfsec:ignore` carries a
  one-line reason next to it (public ALB 443, log stream wildcards, SSE-S3 log delivery buckets,
  `ecr:GetAuthorizationToken`, state object prefix).
- Encryption at rest with CMKs everywhere (RDS, Secrets, S3, CloudWatch, ECR, backups, state);
  Performance Insights, CloudTrail and DynamoDB included. S3 block-public-access is set at account
  level in every account.
- IAM: task roles start empty; the deploy role is PowerUser plus IAM scoped to `kesher-*` roles.
- Logging: VPC flow logs, ALB access logs, WAF logs, CloudFront logs, RDS Postgres logs, Route 53
  query logs, Organization CloudTrail with log-file validation and CloudWatch delivery.

## DR

RDS PITR 35 days. AWS Backup takes a daily snapshot at 03:00 UTC, keeps it 35 days and copies it
to `us-west-2` and to the vault-locked `kesher-locked` vault in club-shared (compliance lock,
min 35 / max 400 days; `changeable_for_days = 3` cooling-off, after which the lock is immutable).

## Tests

```
cd infra/terraform
terraform init -backend=false
terraform test            # plan-mode assertions with mock_provider "aws"; no credentials
terraform fmt -check -recursive
for d in bootstrap envs/*; do (cd $d && terraform init -backend=false && terraform validate); done
```

`tests/network.tftest.hcl` checks the 3 × 3 subnet layout, that no subnet auto-assigns public
IPs, that the database tier has no default route, the endpoint set and flow logs.
`tests/rds.tftest.hcl` checks `storage_encrypted`, `multi_az`, `backup_retention_period = 35`,
`publicly_accessible = false`, pilot sizing, managed master password and SG-only ingress.
`tests/ecs-service.tftest.hcl` checks private networking, Secrets-Manager-only secrets and scaling.
