#!/usr/bin/env bash
# Create or drop a preview database on the staging RDS instance by running the staging
# "db-tool" Fargate task (psql with the RDS-managed master secret) inside the VPC.
#
# Usage: preview-db.sh create|drop
# Env:   PREVIEW_DB_NAME PREVIEW_CLUSTER PREVIEW_TASK_DEF PREVIEW_SUBNETS (csv)
#        PREVIEW_SECURITY_GROUP PREVIEW_REGION PREVIEW_ROLE_ARN (club-staging deploy role)
#
# The caller's ambient credentials are the CI role in club-shared; the script assumes the
# staging deploy role itself because Terraform's provider-level assume_role does not apply to
# local-exec provisioners. Nothing here prints secrets: the task reads them from Secrets Manager.
set -euo pipefail

action="${1:?create|drop}"
: "${PREVIEW_DB_NAME:?}" "${PREVIEW_CLUSTER:?}" "${PREVIEW_TASK_DEF:?}" "${PREVIEW_SUBNETS:?}"
: "${PREVIEW_SECURITY_GROUP:?}" "${PREVIEW_REGION:?}" "${PREVIEW_ROLE_ARN:?}"

if ! [[ "$PREVIEW_DB_NAME" =~ ^preview_[0-9]+$ ]]; then
  echo "refusing database name '$PREVIEW_DB_NAME' (expected preview_<pr>)" >&2
  exit 2
fi

case "$action" in
  create)
    # Idempotent: a re-run after a failed apply finds the database and does nothing.
    sql="GRANT club_app TO CURRENT_USER;
SELECT format('CREATE DATABASE %I OWNER club_app', '${PREVIEW_DB_NAME}')
  WHERE NOT EXISTS (SELECT 1 FROM pg_database WHERE datname = '${PREVIEW_DB_NAME}')\\gexec"
    ;;
  drop)
    sql="DROP DATABASE IF EXISTS \"${PREVIEW_DB_NAME}\" WITH (FORCE);"
    ;;
  *)
    echo "unknown action '$action'" >&2
    exit 2
    ;;
esac

creds="$(aws sts assume-role --role-arn "$PREVIEW_ROLE_ARN" --role-session-name "preview-db-${PREVIEW_DB_NAME}" \
  --duration-seconds 900 --query 'Credentials.[AccessKeyId,SecretAccessKey,SessionToken]' --output text)"
read -r AWS_ACCESS_KEY_ID AWS_SECRET_ACCESS_KEY AWS_SESSION_TOKEN <<<"$creds"
export AWS_ACCESS_KEY_ID AWS_SECRET_ACCESS_KEY AWS_SESSION_TOKEN AWS_REGION="$PREVIEW_REGION"

subnets_json="$(printf '%s' "$PREVIEW_SUBNETS" | jq -R 'split(",")')"
overrides="$(jq -cn --arg sql "$sql" \
  '{containerOverrides: [{name: "psql", command: ["sh", "-c", ("printf %s \"$1\" | psql -v ON_ERROR_STOP=1 -q"), "sh", $sql]}]}')"
network="$(jq -cn --argjson subnets "$subnets_json" --arg sg "$PREVIEW_SECURITY_GROUP" \
  '{awsvpcConfiguration: {subnets: $subnets, securityGroups: [$sg], assignPublicIp: "DISABLED"}}')"

task_arn="$(aws ecs run-task --cluster "$PREVIEW_CLUSTER" --task-definition "$PREVIEW_TASK_DEF" \
  --launch-type FARGATE --platform-version 1.4.0 --count 1 \
  --network-configuration "$network" --overrides "$overrides" \
  --started-by "preview-${action}" --query 'tasks[0].taskArn' --output text)"

echo "db-tool task $task_arn: $action $PREVIEW_DB_NAME"
aws ecs wait tasks-stopped --cluster "$PREVIEW_CLUSTER" --tasks "$task_arn"

exit_code="$(aws ecs describe-tasks --cluster "$PREVIEW_CLUSTER" --tasks "$task_arn" \
  --query 'tasks[0].containers[0].exitCode' --output text)"
if [[ "$exit_code" != "0" ]]; then
  reason="$(aws ecs describe-tasks --cluster "$PREVIEW_CLUSTER" --tasks "$task_arn" \
    --query 'tasks[0].[stoppedReason, containers[0].reason]' --output text)"
  echo "db-tool task failed (exit $exit_code): $reason" >&2
  exit 1
fi
echo "$action $PREVIEW_DB_NAME: done"
