#!/usr/bin/env bash
set -euo pipefail

if [[ $# -ne 5 ]]; then
  echo "usage: $0 <cluster> <service> <container> <command-json> <timeout-seconds>" >&2
  exit 2
fi

cluster="$1"
service="$2"
container="$3"
command_json="$4"
timeout_seconds="$5"

service_json="$(aws ecs describe-services \
  --cluster "$cluster" \
  --services "$service" \
  --output json)"

if ! jq -e '.services | length == 1' <<<"$service_json" >/dev/null; then
  echo "Could not resolve ECS service $service in cluster $cluster" >&2
  exit 1
fi

task_definition="$(jq -r '.services[0].taskDefinition' <<<"$service_json")"
network_configuration="$(jq -c '
  .services[0].networkConfiguration.awsvpcConfiguration
  | {awsvpcConfiguration: {
      subnets: .subnets,
      securityGroups: .securityGroups,
      assignPublicIp: .assignPublicIp
    }}
' <<<"$service_json")"
overrides="$(jq -cn \
  --arg container "$container" \
  --argjson command "$command_json" \
  '{containerOverrides: [{name: $container, command: $command}]}')"

run_json="$(aws ecs run-task \
  --cluster "$cluster" \
  --task-definition "$task_definition" \
  --launch-type FARGATE \
  --network-configuration "$network_configuration" \
  --overrides "$overrides" \
  --started-by "twenty-deploy-${GITHUB_RUN_ID:-manual}" \
  --tags key=RegieManagedBy,value=twenty-publish \
  --output json)"

if jq -e '.failures | length > 0' <<<"$run_json" >/dev/null; then
  jq '.failures' <<<"$run_json" >&2
  exit 1
fi

task_arn="$(jq -r '.tasks[0].taskArn // empty' <<<"$run_json")"
if [[ -z "$task_arn" ]]; then
  echo "ECS did not return a task ARN" >&2
  exit 1
fi

echo "Started one-off ECS task $task_arn"
deadline=$((SECONDS + timeout_seconds))
while (( SECONDS < deadline )); do
  task_json="$(aws ecs describe-tasks \
    --cluster "$cluster" \
    --tasks "$task_arn" \
    --output json)"
  status="$(jq -r '.tasks[0].lastStatus // "UNKNOWN"' <<<"$task_json")"

  if [[ "$status" == "STOPPED" ]]; then
    exit_code="$(jq -r --arg container "$container" \
      '.tasks[0].containers[] | select(.name == $container) | .exitCode // 1' \
      <<<"$task_json")"
    if [[ "$exit_code" != "0" ]]; then
      jq '.tasks[0] | {
        stoppedReason,
        stopCode,
        containers: [.containers[] | {name, exitCode, reason}]
      }' <<<"$task_json" >&2
      exit 1
    fi

    echo "One-off ECS task completed successfully"
    printf '%s\n' "$task_arn"
    exit 0
  fi

  echo "One-off ECS task status: $status"
  sleep 15
done

echo "One-off ECS task did not finish within ${timeout_seconds}s; stopping it" >&2
aws ecs stop-task \
  --cluster "$cluster" \
  --task "$task_arn" \
  --reason "Twenty deployment one-off task timed out" \
  >/dev/null
exit 1
