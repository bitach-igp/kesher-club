#!/usr/bin/env bash
# Writes the AWS CLI profiles the deploy workflow's steps use (T-0050): `deploy` is kesher-deploy in the environment's account, `staging` is
# kesher-deploy in the staging account (the prod gate reads staging's record through it). Both are chained from the credentials in the
# environment (the CI role's), so Terraform keeps the CI role as its ambient identity.
# Env: ENVIRONMENT (staging|prod), STAGING_ACCOUNT, PROD_ACCOUNT (prod only), AWS_REGION, GITHUB_RUN_ID. AWS_CONFIG_FILE overrides the target.
set -euo pipefail
case "$ENVIRONMENT" in
  staging) account="$STAGING_ACCOUNT" ;;
  prod) account="${PROD_ACCOUNT:-}" ;;
  *)
    echo "::error::environment must be staging or prod."
    exit 1
    ;;
esac
for value in "$account" "$STAGING_ACCOUNT"; do
  if ! [[ "$value" =~ ^[0-9]{12}$ ]]; then
    echo "::error::An account id variable is not a 12-digit AWS account id."
    exit 1
  fi
done
config="${AWS_CONFIG_FILE:-$HOME/.aws/config}"
mkdir -p "$(dirname "$config")"
{
  echo "[profile deploy]"
  echo "role_arn = arn:aws:iam::${account}:role/kesher-deploy"
  echo "credential_source = Environment"
  echo "role_session_name = deploy-${ENVIRONMENT}-${GITHUB_RUN_ID}"
  echo "region = ${AWS_REGION}"
  echo
  echo "[profile staging]"
  echo "role_arn = arn:aws:iam::${STAGING_ACCOUNT}:role/kesher-deploy"
  echo "credential_source = Environment"
  echo "role_session_name = deploy-read-staging-${GITHUB_RUN_ID}"
  echo "region = ${AWS_REGION}"
} > "$config"
