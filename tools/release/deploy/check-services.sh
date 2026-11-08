#!/usr/bin/env bash
# Waits for every ECS service to be stable, then proves each one runs the tag. Usage: check-services.sh <cluster> <ecs_service_names.json>
# (`terraform output -json ecs_service_names`). Env: TAG.
# "Stable" is not enough: the deployment circuit breaker rolls a failed task set back, and a rolled-back service is stable again. So each
# service must also have exactly one deployment, COMPLETED, whose task definition runs only images that end in :<tag>.
set -euo pipefail
cluster="$1"
mapfile -t services < <(jq -r 'to_entries[] | .value' "$2")
if [ "${#services[@]}" -eq 0 ]; then
  echo "::error::terraform output ecs_service_names is empty."
  exit 1
fi
for service in "${services[@]}"; do
  echo "Waiting for ${service} to be stable."
  aws ecs wait services-stable --profile deploy --cluster "$cluster" --services "$service"
done
failed=0
for service in "${services[@]}"; do
  described="$(aws ecs describe-services --profile deploy --cluster "$cluster" --services "$service" --output json)"
  primary="$(jq -c '[.services[0].deployments[]? | select(.status == "PRIMARY")][0]' <<<"$described")"
  count="$(jq '.services[0].deployments | length' <<<"$described")"
  state="$(jq -r '.rolloutState // "none"' <<<"$primary")"
  definition_arn="$(jq -r '.taskDefinition // empty' <<<"$primary")"
  wrong=0
  images=()
  if [ -z "$definition_arn" ]; then
    wrong=1
  else
    definition="$(aws ecs describe-task-definition --profile deploy --task-definition "$definition_arn" --output json)"
    mapfile -t images < <(jq -r '.taskDefinition.containerDefinitions[].image' <<<"$definition")
    if [ "${#images[@]}" -eq 0 ]; then
      wrong=1
    fi
    for image in "${images[@]}"; do
      case "$image" in
        *:"${TAG}") ;;
        *) wrong=1 ;;
      esac
    done
  fi
  if [ "$count" != "1" ] || [ "$state" != "COMPLETED" ] || [ "$wrong" -ne 0 ]; then
    echo "::error::${service}: ${count} deployment(s), rollout ${state}, images ${images[*]:-none}; wanted one COMPLETED deployment on ${TAG} (the circuit breaker may have rolled it back)."
    failed=1
  else
    echo "${service}: stable on ${TAG}."
  fi
done
if [ "$failed" -ne 0 ]; then
  exit 1
fi
