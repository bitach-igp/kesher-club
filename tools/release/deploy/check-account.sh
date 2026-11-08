#!/usr/bin/env bash
# The account Terraform applies to (account_id in the TERRAFORM_VARS file) and the account the CLI steps work in (the `deploy` profile, built
# from the repository variables) must be the same account, and shared_account_id must be the shared one: two sources, one truth. A mismatch
# would migrate one account's database and roll another's services. Run before anything changes.
# Usage: check-account.sh <tfvars file>. Env: EXPECTED_ACCOUNT, EXPECTED_SHARED.
set -euo pipefail
file="$1"
value_of() {
  local found
  found="$(sed -nE "s/^[[:space:]]*$1[[:space:]]*=[[:space:]]*\"([0-9]{12})\"[[:space:]]*(#.*)?\$/\\1/p" "$file")"
  if [ "$(printf '%s\n' "$found" | grep -c .)" -ne 1 ]; then
    echo "::error::TERRAFORM_VARS must set $1 exactly once, as a quoted 12-digit account id."
    return 1
  fi
  printf '%s\n' "$found"
}
tf_account="$(value_of account_id)"
tf_shared="$(value_of shared_account_id)"
profile_account="$(aws sts get-caller-identity --profile deploy --query Account --output text)"
if [ "$tf_account" != "$EXPECTED_ACCOUNT" ]; then
  echo "::error::TERRAFORM_VARS account_id (${tf_account}) is not the account of the AWS_*_ACCOUNT_ID variable for this environment (${EXPECTED_ACCOUNT}). Nothing was changed."
  exit 1
fi
if [ "$profile_account" != "$tf_account" ]; then
  echo "::error::The deploy role answers as account ${profile_account} but TERRAFORM_VARS account_id is ${tf_account}. Nothing was changed."
  exit 1
fi
if [ "$tf_shared" != "$EXPECTED_SHARED" ]; then
  echo "::error::TERRAFORM_VARS shared_account_id (${tf_shared}) is not AWS_SHARED_ACCOUNT_ID (${EXPECTED_SHARED}). Nothing was changed."
  exit 1
fi
echo "Terraform and the CLI both work in account ${tf_account}."
