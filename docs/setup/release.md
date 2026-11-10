# Releasing images to ECR

`.github/workflows/release.yml` (T-0030) builds the `api`, `worker`, `admin`, `console` and `migrate` images (the last prepares the database, `docs/setup/database.md`) for one commit that
is already on `main`. It pushes them to club-shared's ECR as `sha-<first 12 characters of the commit>`.
That tag is what staging and prod deploy: their roots run `${ecr_registry}/kesher/{api,worker,admin,console}:${image_tag}`; the database task runs `kesher/migrate:${image_tag}`.

- **Credentials.** The workflow gets them from GitHub OIDC, the way `preview.yml` does, so no access key
  exists anywhere.
- **Reruns.** The repositories are `IMMUTABLE`, so a second run for the same commit skips the push for
  each image already there.
- **Scan gate, SBOM and base images (T-0049).** After each push (and on a rerun that skipped the push) the job
  generates a CycloneDX SBOM with Syft, uploads it as the run artifact `sbom-<app>` and attaches it to the ECR image as an OCI
  referrer (`application/vnd.cyclonedx+json`, `oras attach`). It then waits up to 20 minutes for the Amazon Inspector enhanced scan
  (`envs/shared`: `aws_inspector2_enabler` and `aws_ecr_registry_scanning_configuration`, scan on push for `kesher/*`) and
  fails on any CRITICAL finding (active or suppressed) that has a full or partial fix, unless the exception list below excuses it. The images are built
  `FROM node:22.22.0-bookworm-slim@sha256:<index digest>`; a test (`tools/release/release.test.mjs`) fails if the Dockerfiles disagree.
  A run that fails the gate leaves its image in ECR (the tags are immutable) but prints no deploy line: do not deploy that tag.
- **Deploying.** Not part of this workflow: `deploy.yml` (T-0050, `docs/setup/deploy.md`) takes the tag this one prints, migrates the database, rolls the services, runs the smoke suite and records the tag. Staging on demand; prod only after staging has run the tag for an hour and the GitHub environment's reviewers approve.

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
- ECR with `kesher/api`, `kesher/worker`, `kesher/admin`, `kesher/console` and `kesher/migrate`, all `IMMUTABLE`;
- the hosted zone;
- the GitHub CI role;
- CloudTrail, Security Hub and the locked backup vault.

The defaults for the domain and the member accounts' root e-mails are placeholders on `kesher.example`, and
the apply refuses them (T-0057): pass your real domain and addresses you control. AWS sends each new account's
root sign-in to that address. The domain, its delegation and the mail records are in `docs/setup/domain.md`.

```sh
cd infra/terraform/envs/shared
terraform init -backend-config=backend.hcl
terraform apply \
  -var shared_account_id=<shared id> \
  -var github_repository=bitach-igp/kesher-club \
  -var root_domain=<your domain> \
  -var dmarc_report_address=<mailbox that receives DMARC reports> \
  -var 'member_accounts={staging={name="club-staging",email="<staging root e-mail>"},prod={name="club-prod",email="<prod root e-mail>"}}'
```

### 4. Set the repository variables

These are repository variables, not secrets: none of them is a credential. Set them with the GitHub CLI
from `envs/shared`, or under Settings → Secrets and variables → Actions → Variables:

```sh
gh variable set AWS_CI_ROLE_ARN        --repo bitach-igp/kesher-club --body "$(terraform output -raw ci_role_arn)"
gh variable set AWS_SHARED_ACCOUNT_ID  --repo bitach-igp/kesher-club --body "<shared id>"
gh variable set AWS_STAGING_ACCOUNT_ID --repo bitach-igp/kesher-club --body "$(terraform output -json member_account_ids | jq -r .staging)"
gh variable set AWS_PROD_ACCOUNT_ID    --repo bitach-igp/kesher-club --body "$(terraform output -json member_account_ids | jq -r .prod)"
```

The deploy workflow also needs the GitHub environments `staging` and `prod` (required reviewers and a wait timer on prod), the environment variable `TERRAFORM_VARS` and the environment secret `PAGER_ENDPOINT` (on both): `docs/setup/deploy.md`, "Human steps".

| Variable | Where the value comes from | Used by |
|---|---|---|
| `AWS_CI_ROLE_ARN` | `envs/shared` output `ci_role_arn` | release, preview |
| `AWS_SHARED_ACCOUNT_ID` | `aws sts get-caller-identity` in club-shared | release (ECR registry), preview |
| `AWS_STAGING_ACCOUNT_ID` | `envs/shared` output `member_account_ids.staging` | preview, deploy |
| `AWS_PROD_ACCOUNT_ID` | `envs/shared` output `member_account_ids.prod` | deploy |

## Release a commit

The CI role trusts runs from `main` only (`infra/terraform/modules/oidc`). Start the workflow from `main`
and pass the commit to build as `ref`. The workflow refuses a commit that is not on `main`.

```sh
gh workflow run release.yml --repo bitach-igp/kesher-club --ref main -f ref=<commit sha or tag>
```

In the Actions tab, this is release → Run workflow, with "Use workflow from" set to `main`. The run's
summary prints the tag (and an older `terraform apply -var image_tag=…` line: deploy with `deploy.yml` and that `image_tag` instead, `docs/setup/deploy.md`).

The run needs GitHub Actions minutes. While the account's minutes are used up, every job fails at once,
with no runner and no log.

## Scan exceptions

`.github/security/image-scan-ignore.json` is the only sanctioned way past the scan gate. (Findings an Inspector suppression rule hides still count against the gate, and the gate refuses to run unless the registry is on enhanced scanning.) The gate looks at CRITICAL findings whose fix is available in full (YES) or in part (PARTIAL). It is reviewed like code: one pull
request, one owner who signs it.

```json
{
  "entries": [
    {
      "id": "CVE-2026-12345",
      "image": "kesher/api",
      "reason": "Why it cannot be exploited here, and the card that removes it.",
      "owner": "@github-handle-of-the-person-who-accepts-the-risk",
      "signedOn": "2026-11-10",
      "expires": "2026-12-10"
    }
  ]
}
```

- `id` is a `CVE-YYYY-NNNN…` or `GHSA-xxxx-xxxx-xxxx` id (GHSA in its own lower case); `image` is one of `kesher/api`, `kesher/worker`, `kesher/admin`, `kesher/console`, `kesher/migrate` or `*`. A typo fails the release.
- `expires` is at most 30 days after `signedOn`, and `signedOn` is not in the future. An entry is in force through its
  `expires` day (UTC). To extend one, sign a new entry with a new reason; there is no renewal in place.
- An expired entry excuses nothing: the finding blocks the release again. A malformed entry, or one that lasts
  more than 30 days, fails every release, even once expired, so delete lapsed entries.
- The list is checked first thing in every image job, before anything is built, by `tools/release/check-findings.mjs`
  (`node tools/release/check-findings.mjs --ignore .github/security/image-scan-ignore.json` checks it on your machine).

## Updating the pinned base image

The digest in the five Dockerfiles is the multi-architecture index digest of `node:22.22.0-bookworm-slim`. To move to a new
tag, resolve its digest (`docker buildx imagetools inspect node:<tag> --format '{{.Manifest.Digest}}'`) and change all five
`FROM` lines in one commit; the Dockerfile test fails if one is missed.

## Check it worked

```sh
for app in api worker admin console migrate; do
  aws ecr describe-images --registry-id <shared id> --repository-name "kesher/${app}" \
    --image-ids imageTag=sha-<12 characters> --query 'imageDetails[0].imagePushedAt' --output text
done
```

Each line prints a push time. A referrer exists too: `oras discover --artifact-type application/vnd.cyclonedx+json <registry>/kesher/api@<digest>`
lists the SBOM, and the finished run has `sbom-api` and the other artifacts. Run the workflow again for the same commit: each image's job reports
"already there, skipped", and the run is green.

## Known limitations of the console on the public ALB (T-0047)

The console is not deployed yet, so nothing regresses today. One still needs an owner's follow-up card before a console is used in production:

- **Client address (T-0069).** The console calls the API at the public `api-il` host, so the hop goes through the NAT gateway and the public ALB. The API reads the last `x-forwarded-for` entry (it assumes one internet-facing ALB), so bank-application links the console relays record the NAT address, and every console and admin call shares the NAT addresses for the WAF's per-IP rate limit (2000 per 5 minutes).
- **Body size (T-0068, fixed).** The ALB's WAF rule `SizeRestrictions_BODY` blocks bodies over 8 KB; the console's roster import sends up to 900 KB. `modules/alb`'s `large_body_route` counts that one rule and a second rule (the `body-size-outside-exempt-host`, `-path` and `-method` rules) blocks it everywhere except `POST /v1/institutions/{id}/rosters` on the IL API host, on the public ALB only. After the next apply, check a 900 KB import in staging (200) and an oversized body on any other route (403).
