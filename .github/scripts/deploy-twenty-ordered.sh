#!/usr/bin/env bash
set -euo pipefail

required=(
  AWS_REGION AWS_ACCOUNT_ID ECR_NAMESPACE ECR_REPO ECS_CLUSTER
  SERVER_SERVICE WORKER_SERVICE IMAGE_DIGEST
)
for name in "${required[@]}"; do
  if [[ -z "${!name:-}" ]]; then
    echo "$name is required" >&2
    exit 1
  fi
done

RUNNER_FAMILY="${RUNNER_FAMILY:-twenty-upgrade-runner}"
TASK_TIMEOUT_SECONDS="${TASK_TIMEOUT_SECONDS:-7200}"
SERVICE_TIMEOUT_SECONDS="${SERVICE_TIMEOUT_SECONDS:-1800}"
PHONE_INDEX_TIMEOUT_SECONDS="${PHONE_INDEX_TIMEOUT_SECONDS:-3600}"
IMAGE_REPOSITORY="$AWS_ACCOUNT_ID.dkr.ecr.$AWS_REGION.amazonaws.com/$ECR_NAMESPACE/$ECR_REPO"
PINNED_IMAGE="$IMAGE_REPOSITORY@$IMAGE_DIGEST"
ACTIVE_TASK_ARN=""

cleanup() {
  if [[ -n "$ACTIVE_TASK_ARN" ]]; then
    aws ecs stop-task \
      --cluster "$ECS_CLUSTER" \
      --task "$ACTIVE_TASK_ARN" \
      --reason "Ordered deployment interrupted" >/dev/null || true
  fi
}
trap cleanup EXIT INT TERM

register_pinned_task_definition() {
  local family="$1"
  local container_name="$2"
  local source_definition
  local matching_containers
  local registration

  source_definition="$(aws ecs describe-task-definition \
    --task-definition "$family" \
    --query taskDefinition \
    --output json)"
  matching_containers="$(jq --arg name "$container_name" \
    '[.containerDefinitions[] | select(.name == $name)] | length' \
    <<<"$source_definition")"
  if [[ "$matching_containers" != "1" ]]; then
    echo "$family must contain exactly one $container_name container" >&2
    exit 1
  fi

  registration="$(jq \
    --arg image "$PINNED_IMAGE" \
    --arg container "$container_name" \
    '{
      family, taskRoleArn, executionRoleArn, networkMode, containerDefinitions,
      volumes, placementConstraints, requiresCompatibilities, cpu, memory,
      runtimePlatform, ephemeralStorage, proxyConfiguration,
      inferenceAccelerators, ipcMode, pidMode
    }
    | with_entries(select(.value != null and .value != []))
    | .containerDefinitions |= map(
        if .name == $container then .image = $image else . end
      )' <<<"$source_definition")"

  aws ecs register-task-definition \
    --cli-input-json "$registration" \
    --query 'taskDefinition.taskDefinitionArn' \
    --output text
}

network_configuration() {
  aws ecs describe-services \
    --cluster "$ECS_CLUSTER" \
    --services "$SERVER_SERVICE" \
    --query 'services[0].networkConfiguration' \
    --output json
}

tail_task_logs() {
  local task_arn="$1"
  local task_id="${task_arn##*/}"

  aws logs tail /ecs/twenty-upgrade-runner \
    --since 2h \
    --log-stream-name-prefix "upgrade/upgrade/$task_id" || true
}

run_command() {
  local label="$1"
  local task_definition="$2"
  shift 2
  local command_json
  local overrides
  local run_result
  local deadline
  local task_state
  local last_status
  local exit_code

  command_json="$(printf '%s\n' node dist/command/command "$@" | jq -R . | jq -s .)"
  overrides="$(jq -n \
    --arg name upgrade \
    --argjson command "$command_json" \
    '{containerOverrides: [{name: $name, command: $command}]}')"
  run_result="$(aws ecs run-task \
    --cluster "$ECS_CLUSTER" \
    --launch-type FARGATE \
    --task-definition "$task_definition" \
    --network-configuration "$(network_configuration)" \
    --overrides "$overrides" \
    --started-by "github-${GITHUB_RUN_ID:-manual}" \
    --output json)"

  if [[ "$(jq '.failures | length' <<<"$run_result")" != "0" ]]; then
    jq '.failures' <<<"$run_result" >&2
    exit 1
  fi

  ACTIVE_TASK_ARN="$(jq -r '.tasks[0].taskArn // empty' <<<"$run_result")"
  if [[ -z "$ACTIVE_TASK_ARN" ]]; then
    echo "$label did not start an ECS task" >&2
    exit 1
  fi

  echo "$label task: $ACTIVE_TASK_ARN"
  deadline=$((SECONDS + TASK_TIMEOUT_SECONDS))
  while (( SECONDS < deadline )); do
    task_state="$(aws ecs describe-tasks \
      --cluster "$ECS_CLUSTER" \
      --tasks "$ACTIVE_TASK_ARN" \
      --query 'tasks[0]' \
      --output json)"
    last_status="$(jq -r '.lastStatus // empty' <<<"$task_state")"
    if [[ "$last_status" == "STOPPED" ]]; then
      break
    fi
    sleep 15
  done

  if [[ "${last_status:-}" != "STOPPED" ]]; then
    echo "$label did not stop within $TASK_TIMEOUT_SECONDS seconds" >&2
    exit 1
  fi

  tail_task_logs "$ACTIVE_TASK_ARN"
  exit_code="$(jq -r '.containers[] | select(.name == "upgrade") | .exitCode // empty' \
    <<<"$task_state")"
  if [[ "$exit_code" != "0" ]]; then
    jq '{stoppedReason, containers: [.containers[] | {name, exitCode, reason}]}' \
      <<<"$task_state" >&2
    exit 1
  fi

  ACTIVE_TASK_ARN=""
}

wait_for_service() {
  local service="$1"
  local container_name="$2"
  local deadline=$((SECONDS + SERVICE_TIMEOUT_SECONDS))
  local service_state
  local task_arns
  local -a task_arn_list
  local task_state

  while (( SECONDS < deadline )); do
    service_state="$(aws ecs describe-services \
      --cluster "$ECS_CLUSTER" \
      --services "$service" \
      --output json)"

    if jq -e 'any(.services[].deployments[]; .rolloutState == "FAILED")' \
      <<<"$service_state" >/dev/null; then
      jq '.services[0] | {serviceName, deployments, events: .events[0:10]}' \
        <<<"$service_state" >&2
      exit 1
    fi

    if jq -e '.services[0]
      | .desiredCount > 0
        and .desiredCount == .runningCount
        and .pendingCount == 0
        and (.deployments | length) == 1
        and .deployments[0].status == "PRIMARY"
        and .deployments[0].rolloutState == "COMPLETED"' \
      <<<"$service_state" >/dev/null; then
      task_arns="$(aws ecs list-tasks \
        --cluster "$ECS_CLUSTER" \
        --service-name "$service" \
        --desired-status RUNNING \
        --query 'taskArns' \
        --output json)"
      mapfile -t task_arn_list < <(jq -r '.[]' <<<"$task_arns")
      if [[ "${#task_arn_list[@]}" == "0" ]]; then
        sleep 15
        continue
      fi
      task_state="$(aws ecs describe-tasks \
        --cluster "$ECS_CLUSTER" \
        --tasks "${task_arn_list[@]}" \
        --output json)"
      if jq -e \
        --arg container "$container_name" \
        --arg digest "$IMAGE_DIGEST" \
        '(.tasks | length) > 0 and all(.tasks[];
          any(.containers[]; .name == $container and .imageDigest == $digest))' \
        <<<"$task_state" >/dev/null; then
        echo "$service is stable on $IMAGE_DIGEST"
        return
      fi
    fi

    sleep 15
  done

  echo "$service did not converge on $IMAGE_DIGEST within $SERVICE_TIMEOUT_SECONDS seconds" >&2
  exit 1
}

echo "Registering task definitions pinned to $IMAGE_DIGEST"
runner_task_definition="$(register_pinned_task_definition "$RUNNER_FAMILY" upgrade)"
worker_task_definition="$(register_pinned_task_definition "$WORKER_SERVICE" worker)"
server_task_definition="$(register_pinned_task_definition "$SERVER_SERVICE" server)"

run_command "schema upgrade" "$runner_task_definition" upgrade --verbose
run_command "schema status" "$runner_task_definition" \
  upgrade:status --failed-only --fail-on-unhealthy

aws ecs update-service \
  --cluster "$ECS_CLUSTER" \
  --service "$WORKER_SERVICE" \
  --task-definition "$worker_task_definition" >/dev/null
wait_for_service "$WORKER_SERVICE" worker

run_command "phone-search backfill" "$runner_task_definition" \
  phone-search:index:status \
  --wait \
  --timeout-seconds "$PHONE_INDEX_TIMEOUT_SECONDS" \
  --fail-on-unhealthy

aws ecs update-service \
  --cluster "$ECS_CLUSTER" \
  --service "$SERVER_SERVICE" \
  --task-definition "$server_task_definition" >/dev/null
wait_for_service "$SERVER_SERVICE" server

run_command "convergence upgrade" "$runner_task_definition" upgrade --verbose
run_command "convergence schema status" "$runner_task_definition" \
  upgrade:status --failed-only --fail-on-unhealthy
run_command "convergence phone-search backfill" "$runner_task_definition" \
  phone-search:index:status \
  --wait \
  --timeout-seconds "$PHONE_INDEX_TIMEOUT_SECONDS" \
  --fail-on-unhealthy
run_command "shared cache flush" "$runner_task_definition" cache:flush

echo "Ordered deployment completed on $IMAGE_DIGEST"
