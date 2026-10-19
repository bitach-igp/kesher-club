# Releasing images to ECR

`.github/workflows/release.yml` (T-0030) builds the `api`, `worker` and `admin` images for one commit that
is already on `main`. It pushes them to club-shared's ECR as `sha-<first 12 characters of the commit>`.
That tag is what staging and prod deploy: their roots run `${ecr_registry}/kesher/{api,worker,admin}:${image_tag}`.

- **Credentials.** The workflow gets them from GitHub OIDC, the way `preview.yml` does, so no access key
  exists anywhere.
- **Reruns.** The repositories are `IMMUTABLE`, so a second run for the same commit skips the push for
  each image already there.
- **Deploying.** Not part of this workflow; it is a card of its own.

The workflow does nothing useful until a person with AWS administrator access has done the one-time steps
below, in this order.

## One-time setup

### 1. Sign in to club-shared as an administrator

You need:
- club-shared, the Organization management account;
- an Identity Center administrator permission set;
- Terraform 1.9.8 and AWS CLI v2.

Sign in, then check the account id. `<shared id>` below is this 12-digit value:

```sh
aws sso login --profile club-shared-admin
export AWS_PROFILE=club-shared-admin
aws sts get-caller-identity --query Account --output text
```

### 2. Apply `infra/terraform/bootstrap`

This step uses local state, runs once and creates the Terraform state bucket, the lock table and their key:

```sh
cd infra/terraform/bootstrap
terraform init
terraform apply -var shared_account_id=<shared id>
```

Keep this root's `terraform.tfstate` in the team password manager (`infra/terraform/README.md`, step 2).

### 3. Apply `infra/terraform/envs/shared`

This step creates:
- the Organization, the staging and prod accounts and the SCP;
- ECR with `kesher/api`, `kesher/worker` and `kesher/admin`, all `IMMUTABLE`;
- the hosted zone;
- the GitHub CI role;
- CloudTrail, Security Hub and the locked backup vault.

The default root e-mails for the member accounts are placeholders on `kesher.example`. Pass real
addresses you control: AWS sends each new account's root sign-in to that address.

```sh
cd infra/terraform/envs/shared
terraform init -backend-config=backend.hcl
terraform apply \
  -var shared_account_id=<shared id> \
  -var github_repository=bitach-igp/kesher-club \
  -var 'member_accounts={staging={name="club-staging",email="<staging root e-mail>"},prod={name="club-prod",email="<prod root e-mail>"}}'
```

### 4. Set the repository variables

These are repository variables, not secrets: none of them is a credential. Set them with the GitHub CLI
from `envs/shared`, or under Settings → Secrets and variables → Actions → Variables:

```sh
gh variable set AWS_CI_ROLE_ARN        --repo bitach-igp/kesher-club --body "$(terraform output -raw ci_role_arn)"
gh variable set AWS_SHARED_ACCOUNT_ID  --repo bitach-igp/kesher-club --body "<shared id>"
gh variable set AWS_STAGING_ACCOUNT_ID --repo bitach-igp/kesher-club --body "$(terraform output -json member_account_ids | jq -r .staging)"
```

| Variable | Where the value comes from | Used by |
|---|---|---|
| `AWS_CI_ROLE_ARN` | `envs/shared` output `ci_role_arn` | release, preview |
| `AWS_SHARED_ACCOUNT_ID` | `aws sts get-caller-identity` in club-shared | release (ECR registry), preview |
| `AWS_STAGING_ACCOUNT_ID` | `envs/shared` output `member_account_ids.staging` | preview |

## Release a commit

The CI role trusts runs from `main` only (`infra/terraform/modules/oidc`). Start the workflow from `main`
and pass the commit to build as `ref`. The workflow refuses a commit that is not on `main`.

```sh
gh workflow run release.yml --repo bitach-igp/kesher-club --ref main -f ref=<commit sha or tag>
```

In the Actions tab, this is release → Run workflow, with "Use workflow from" set to `main`. The run's
summary prints the tag and the `terraform apply -var image_tag=…` line for staging or prod.

The run needs GitHub Actions minutes. While the account's minutes are used up, every job fails at once,
with no runner and no log.

## Check it worked

```sh
for app in api worker admin; do
  aws ecr describe-images --registry-id <shared id> --repository-name "kesher/${app}" \
    --image-ids imageTag=sha-<12 characters> --query 'imageDetails[0].imagePushedAt' --output text
done
```

Each line prints a push time. Run the workflow again for the same commit: each image's job reports
"already there, skipped", and the run is green.
