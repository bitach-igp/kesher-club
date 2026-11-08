#!/usr/bin/env bash
# Runs the migrate task (T-0044) and waits for exit code 0; anything else fails. Usage: run-migrate.sh <migrate_task.json>, the file being
# `terraform output -json migrate_task`. Env: TAG, GITHUB_RUN_ID. Optional: POLL_SECONDS (15), RETRY_SECONDS (5), DEADLINE_SECONDS (1800),
# GITHUB_STEP_SUMMARY.
# Whatever ends this script before the task has stopped (a failed poll, the deadline, a cancelled run) stops the task too, so a re-run never
# starts a second migration beside a first that is still going.
set -euo pipefail
cfg="$(cat "$1")"
poll="${POLL_SECONDS:-15}"
retry="${RETRY_SECONDS:-5}"
limit="${DEADLINE_SECONDS:-1800}"
summary="${GITHUB_STEP_SUMMARY:-/dev/null}"
cluster="$(jq -r '.cluster' <<<"$cfg")"
family="$(jq -r '.task_definition' <<<"$cfg")"
container="$(jq -r '.container' <<<"$cfg")"
network="$(jq -c '{awsvpcConfiguration: {subnets: .network_configuration.subnets, securityGroups: .network_configuration.security_groups, assignPublicIp: (if .network_configuration.assign_public_ip then "ENABLED" else "DISABLED" end)}}' <<<"$cfg")"

task_arn=""
settled=0
cleanup() {
  local rc=$?
  trap - EXIT
  if [ -n "$task_arn" ] && [ "$settled" -ne 1 ]; then
    echo "Stopping the migrate task ${task_arn} before leaving."
    aws ecs stop-task --profile deploy --cluster "$cluster" --task "$task_arn" --reason "deploy ${GITHUB_RUN_ID}: the deploy step ended" >/dev/null 2>&1 || echo "::warning::Could not stop ${task_arn}; check the cluster for a running migrate task before deploying again."
  fi
  exit "$rc"
}
trap cleanup EXIT
trap 'exit 130' INT
trap 'exit 143' TERM

definition="$(aws ecs describe-task-definition --profile deploy --task-definition "$family" --query taskDefinition --output json)"
definition_arn="$(jq -r '.taskDefinitionArn' <<<"$definition")"
image="$(jq -r --arg name "$container" '.containerDefinitions[] | select(.name == $name) | .image' <<<"$definition")"
case "$image" in
  */kesher/migrate:"${TAG}") echo "Running ${definition_arn} (${image})." ;;
  *)
    echo "::error::The latest migrate task definition runs ${image}, not kesher/migrate:${TAG}; refusing to migrate with another image."
    exit 1
    ;;
esac

started="$(aws ecs run-task --profile deploy --cluster "$cluster" --task-definition "$definition_arn" --launch-type FARGATE --count 1 --started-by "deploy-${GITHUB_RUN_ID}" --network-configuration "$network" --output json)"
task_arn="$(jq -r '.tasks[0].taskArn // empty' <<<"$started")"
if [ -z "$task_arn" ]; then
  echo "::error::ecs run-task started no task: $(jq -c '.failures' <<<"$started")"
  exit 1
fi
echo "Started ${task_arn}"

# One poll, retried a few times: a throttled or dropped describe-tasks must not abandon a running migration.
task=""
describe() {
  local attempt=0 err status
  err="$(mktemp)"
  while true; do
    if task="$(aws ecs describe-tasks --profile deploy --cluster "$cluster" --tasks "$task_arn" --output json 2>"$err")"; then
      status="$(jq -r '.tasks[0].lastStatus // empty' <<<"$task")"
      if [ -n "$status" ]; then
        rm -f "$err"
        return 0
      fi
    fi
    attempt=$((attempt + 1))
    if [ "$attempt" -ge 5 ]; then
      echo "::error::describe-tasks failed ${attempt} times for ${task_arn}: $(cat "$err")"
      rm -f "$err"
      return 1
    fi
    sleep "$retry"
  done
}

deadline=$((SECONDS + limit))
while true; do
  describe
  status="$(jq -r '.tasks[0].lastStatus' <<<"$task")"
  echo "migrate task: ${status}"
  if [ "$status" = "STOPPED" ]; then
    settled=1
    break
  fi
  if [ "$SECONDS" -ge "$deadline" ]; then
    echo "::error::The migrate task did not finish within ${limit} seconds; it is being stopped. No service was rolled."
    exit 1
  fi
  sleep "$poll"
done

exit_code="$(jq -r --arg name "$container" '[.tasks[0].containers[] | select(.name == $name) | .exitCode][0] // "none"' <<<"$task")"
aws logs tail "/kesher/${family}" --profile deploy --since 2h --format short 2>/dev/null | tail -n 60 || true
if [ "$exit_code" != "0" ]; then
  echo "::error::The migrate task exited with ${exit_code} ($(jq -r '.tasks[0].stoppedReason // "no reason given"' <<<"$task")). No service was rolled."
  exit 1
fi
echo "The migrate task exited 0." | tee -a "$summary"
