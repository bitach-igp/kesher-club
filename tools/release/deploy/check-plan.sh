#!/usr/bin/env bash
# Fails when a Terraform plan (as `terraform show -json`) changes anything outside one module. The migrate-only plan is the first apply of a
# deploy, and it must not be able to roll a service. No-op and read actions are not changes.
# Usage: check-plan.sh <plan.json> [module address prefix, default module.migrate.]
set -euo pipefail
plan="$1"
prefix="${2:-module.migrate.}"
outside="$(jq -r --arg prefix "$prefix" '[.resource_changes[]? | select(.change.actions | all(. != "no-op" and . != "read")) | select(.address | startswith($prefix) | not) | .address] | join(", ")' "$plan")"
if [ -n "$outside" ]; then
  echo "::error::The migrate-only plan also changes: ${outside}. Services must not roll before the migration, so nothing is applied. Apply that change on its own first (infra/terraform/README.md) and run this workflow again."
  exit 1
fi
echo "The plan changes nothing outside ${prefix%.}."
