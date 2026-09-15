# Regie ECS Upgrade Runbook

This runbook covers promotion of a Twenty release through the Regie stage and production ECS environments when the release contains instance or workspace upgrade commands. It incorporates the rollout requirements established for the upstream synchronization in REGIE-io/twenty#90 and the stage and production evidence collected during the subsequent promotion.

The objective is zero-downtime application deployment with exactly one database upgrade sequence.

For how upgrade commands are authored and how their cursors work, see [UPGRADE_COMMANDS.md](./UPGRADE_COMMANDS.md).

For the complete schema-authoring and fleet-convergence workflow, see [REGIE_WORKSPACE_SCHEMA_CHANGE_GUIDE.md](./REGIE_WORKSPACE_SCHEMA_CHANGE_GUIDE.md).

## Invariants

Do not proceed unless all of these remain true:

- Long-lived `twenty-server` and `twenty-worker` tasks set `DISABLE_DB_MIGRATIONS=true`.
- Only a dedicated, non-load-balanced command task runs `upgrade`.
- There is never more than one upgrade runner against an environment.
- The `upgrade` command holds the PostgreSQL advisory lock `twenty:upgrade-sequence` for the complete sequence.
- The runner, server, and worker resolve to the same immutable image digest.
- `DISABLE_CRON_JOBS_REGISTRATION=true` is set on the upgrade runner. It is not required on the server, which registers the environment's scheduled jobs.
- The compatible Go CRM consumer is deployed before Twenty reaches a schema or response shape that requires it.
- A successful finite ECS command task exits with code `0`. `EssentialContainerExited` alone is not a failure verdict.
- A database upgrade is not complete until both long-lived services have been restarted after it and the post-restart canaries pass.

## Why service startup must not run upgrades

The image entrypoint runs database setup, cache flush, and `upgrade` unless `DISABLE_DB_MIGRATIONS=true`. A normal ECS rolling deployment can temporarily run multiple server tasks. Allowing entrypoint upgrades would therefore create concurrent upgrade sequences and couple service health to a long-running database operation.

The safe topology is:

1. Service tasks start only the application process.
2. One dedicated command task runs the upgrade sequence.
3. Service tasks are rolled again after the upgrade to rebuild all in-memory metadata from the completed schema.

Shared-cache invalidation is not a replacement for the final restart. Upgrade-aware TypeORM metadata is built inside each process. In production, a worker that started before the `2.31` `isDeprecated` upgrade continued to hide that field after the upgrade completed, causing the hourly marketplace catalog sync to fail. Restarting the server and worker rebuilt their metadata, after which the same sync completed successfully.

## Environment inputs

Set these explicitly for the target environment. Do not infer production values from stage.

```bash
export AWS_PROFILE="<approved-stage-or-production-profile>"
export AWS_REGION="us-east-1"
export AWS_ACCOUNT_ID="<target-account-id>"
export ECS_CLUSTER="main"
export SERVER_SERVICE="twenty-server"
export WORKER_SERVICE="twenty-worker"
export ECR_REPOSITORY="momentum/twenty"
export RELEASE_SHA="<full-git-commit>"
export IMAGE_DIGEST="sha256:<digest-for-release-sha>"
export TWENTY_BASE_URL="<target-environment-origin>"
```

The repository deploy workflows currently identify these accounts:

| Environment | Account        | Promotion branch |
| ----------- | -------------- | ---------------- |
| stage       | `939603205566` | `stage`          |
| production  | `827949090804` | `main`           |

## Phase 1: Release and compatibility gates

### 1. Verify source containment

Record the exact Twenty commit to promote and the exact Go commit deployed in the target environment.

For releases that depend on a Go compatibility change, confirm that the deployed Go commit contains that change. A PR being merged into `develop` is not sufficient evidence that stage or production contains it.

For the PR #90 release, the Go revision had to contain REGIE-io/go#1609 because older consumers rejected Twenty's paginated metadata-view response.

### 2. Pass the cross-version CI gate

The release must pass the cross-version upgrade workflow, including both overlap directions:

- new Twenty code against the pre-upgrade schema;
- old Twenty code against the expanded or partially upgraded schema;
- fresh-workspace provisioning while the upgrade is active.

If neither application version can safely overlap the database transition, stop. Split the change into expand, migrate, and contract releases. Do not substitute an untested maintenance window.

An upstream synchronization may intentionally change upgrade commands outside the current version directory. In that case, apply the `ci:allow-previous-version-upgrade-mutation` label and trigger a fresh check run. The label only permits the CI mutation guard to evaluate the intentional historical changes; it does not cause an environment migration to run.

### 3. Review upgrade scope

Before promotion, identify:

- fast instance commands;
- slow instance commands and expected data volume;
- workspace command segments;
- active and suspended workspace count;
- forward-only or contracting changes that make application rollback unsafe;
- commands whose interruption safety depends on idempotency rather than a transaction.

Record the expected sequence and a rough duration from stage. Production may take longer.

## Phase 2: Build and identify the release image

Build the release once and push a traceable SHA tag. Resolve and record its immutable digest:

```bash
aws --profile "$AWS_PROFILE" --region "$AWS_REGION" ecr describe-images \
  --repository-name "$ECR_REPOSITORY" \
  --image-ids imageTag="regie-${RELEASE_SHA:0:10}" \
  --query 'imageDetails[0].imageDigest' \
  --output text
```

The desired end state is for service task definitions and the command-runner task definition to reference the digest directly. The current service workflows deploy through mutable `regie-stage-latest` and `regie-prod-latest` tags, so every rollout and restart must at minimum verify the resolved task `imageDigest` equals `IMAGE_DIGEST`. A later tag move must not change any task in this release.

## Phase 3: Prepare the long-lived services

### 1. Verify migration-disabled task definitions

Inspect the server and worker task definitions without printing secret values:

```bash
for service in "$SERVER_SERVICE" "$WORKER_SERVICE"; do
  task_definition=$(aws --profile "$AWS_PROFILE" --region "$AWS_REGION" ecs describe-services \
    --cluster "$ECS_CLUSTER" \
    --services "$service" \
    --query 'services[0].taskDefinition' \
    --output text)

  aws --profile "$AWS_PROFILE" --region "$AWS_REGION" ecs describe-task-definition \
    --task-definition "$task_definition" \
    --query 'taskDefinition.{taskDefinitionArn:taskDefinitionArn,image:containerDefinitions[0].image,disableMigrations:containerDefinitions[0].environment[?name==`DISABLE_DB_MIGRATIONS`].value|[0]}' \
    --output json
done
```

Both definitions must report `disableMigrations` as `true` before any service rollout begins.

### 2. Roll the compatible application version

If the compatibility matrix proves new code can run on the old schema, roll server and worker first. If only the old code is compatible with the expanded schema, run the upgrade first and roll afterward. If neither is safe, return to Phase 1 and split the release.

For each service rollout, require:

- exactly one `PRIMARY` deployment;
- `rolloutState=COMPLETED`;
- desired count equals running count;
- pending count is zero;
- failed replacement count is zero;
- running tasks resolve to `IMAGE_DIGEST`;
- the server target is healthy;
- startup logs contain `Database setup and migrations are disabled, skipping...`.

Do not treat a one-off command task as a failed service replacement.

## Phase 4: Prepare exactly one command runner

Use a dedicated task family such as `twenty-upgrade-runner`. It must have:

- the release image pinned as `<repository>@${IMAGE_DIGEST}`;
- no load balancer, port mapping, or container health check;
- the same task role, execution role, network, secrets, and required environment configuration as the server;
- `DISABLE_DB_MIGRATIONS=true`;
- `DISABLE_CRON_JOBS_REGISTRATION=true`;
- command `yarn command:prod upgrade --verbose`;
- a unique `startedBy` value containing the release or run identifier;
- CloudWatch logs in a command-specific stream prefix;
- ARM64 Linux runtime to match the release image.

### Production-proven resource baseline

For the production run with 278 provisioned workspaces, a 2-vCPU, 4-GB Fargate task hit Node's default approximately 2-GB old-space limit after completing two workspace segments and entering the third. Extra task memory alone does not raise Node's heap limit.

The successful retry used:

- `cpu=2048`;
- `memory=8192`;
- `NODE_OPTIONS=--max-old-space-size=6144`.

Use that as the current minimum baseline for Regie production, not a permanent sizing guarantee. Review peak runner memory and workspace growth before later large upgrades.

### Serialization gate

Before launching the runner, verify there is no running task in the runner family:

```bash
aws --profile "$AWS_PROFILE" --region "$AWS_REGION" ecs list-tasks \
  --cluster "$ECS_CLUSTER" \
  --family twenty-upgrade-runner \
  --desired-status RUNNING
```

The result must be empty. Deployment workflow concurrency and this pre-launch check are defense in depth. The `upgrade` command also takes the database-backed `twenty:upgrade-sequence` advisory lock. If another runner owns it, the new runner exits nonzero before reading or changing the sequence. No shell, service replacement, or second workflow may bypass that failure.

## Phase 5: Run and monitor the upgrade

Start one runner in the same private subnets and security groups as the server. Record:

- task ARN and task-definition revision;
- `startedBy`;
- exact image digest;
- log stream;
- start time;
- expected workspace count.

Monitor all three sources until completion:

1. command logs for instance-command results, `workspace.start`, `workspace.success`, and the final `summary`;
2. `yarn command:prod upgrade:status` for instance and workspace health;
3. `core.upgradeMigration` for the last recorded command and failed attempts across active and suspended workspaces.

After the runner exits, execute the status gate from the same immutable image:

```bash
node dist/command/command upgrade:status --failed-only --fail-on-unhealthy
```

The command exits nonzero if the instance or any selected workspace is behind or failed. Omitting `--fail-on-unhealthy` retains the report-only behavior intended for interactive inspection.

The success gate is all of:

- ECS task stopped;
- container exit code is `0`;
- final summary reports zero workspace failures;
- expected workspaces reached the final cursor;
- no `aborted`, `Command failed`, `Error in workspace`, fatal error, or out-of-memory event appears.
- `upgrade:status --failed-only --fail-on-unhealthy` exits `0`.

`stopCode=EssentialContainerExited` is expected for a finite command. Always use the container exit code and command logs for the verdict.

## Recovery from interruption or failure

Do not launch a second runner blindly and do not roll the database backward.

1. Confirm the previous runner is stopped and no other runner is active.
2. Capture its exit code, final log events, last workspace, and last `core.upgradeMigration` cursor.
3. Determine whether the failure happened between recorded commands or inside an unfinished command.
4. Correct the execution constraint while keeping the same immutable image.
5. Rerun the unfiltered `upgrade --verbose` command. Do not manually choose a starting workspace unless the code's normal cursor resolution cannot be used and the exception has been reviewed.

The upgrade runner reads the stored instance and per-workspace cursors. Completed instance commands are skipped, and each workspace receives only commands pending in its current segment. This was verified when the production runner resumed after an out-of-memory exit and completed all 278 workspaces without replaying already recorded commands.

An abrupt exit can leave the command in progress unrecorded. Its retry safety still depends on that command being transactional or idempotent. Inspect the command before rerunning if the failure was not at a clean boundary.

### Out-of-memory signature

The observed Node failure exited `129` and logged:

```text
FATAL ERROR: Ineffective mark-compacts near heap limit Allocation failed - JavaScript heap out of memory
```

Treat the log signature as authoritative; do not assume every memory failure exits `137`. Raise both Fargate task memory and Node old-space headroom, leaving capacity for native allocations.

## Phase 6: Mandatory post-upgrade service restart

After the upgrade succeeds, force a new rolling deployment of both long-lived services using their migration-disabled task definitions and the same release digest.

This restart is mandatory even when cache invalidation reports success. It refreshes process-local upgrade-aware entity metadata and other schema-derived state.

Verify during the restart:

- `DISABLE_DB_MIGRATIONS=true` remains present;
- the replacement server and worker resolve to `IMAGE_DIGEST`;
- the old tasks remain until replacements are ready;
- both services return to one `PRIMARY/COMPLETED` deployment;
- desired equals running and pending is zero;
- the old ALB target finishes draining, leaving only the new healthy target;
- fresh startup logs contain no error or fatal event.

## Phase 7: Post-restart canaries

Run these in order.

### 1. Public and existing-workspace smoke

```bash
curl --fail --silent --show-error --max-time 15 "$TWENTY_BASE_URL/healthz"
```

Verify an existing workspace can perform representative reads and writes, including any feature touched by the release. Review the new server and worker log streams rather than the whole log group, which may contain earlier known failures.

### 2. Marketplace catalog sync

Run one finite command task from the same release image with:

```bash
yarn command:prod marketplace:catalog-sync
```

Require exit code `0`, `Marketplace catalog sync completed`, and zero per-package failures. This canary exercises upgrade-aware instance metadata and caught the stale `isDeprecated` metadata state in production.

### 3. Fresh Go CRM provisioning

Create an ephemeral workspace through the real Go CRM provisioning path. Verify:

- API key and workspace member;
- required custom fields and indexes;
- Lists objects and views;
- metadata response readback through the deployed Go consumer;
- application logs remain clean.

Purge the ephemeral workspace after evidence is captured. A workspace created during an active upgrade must either begin at the new schema version or be included in a final convergence scan before completion.

## Phase 8: Stability observation

Hold an observation window after the final restart and canaries. At minimum verify:

- repeated public health checks remain successful;
- server and worker remain `PRIMARY/COMPLETED`, desired equals running, pending is zero;
- the target group has one healthy target and zero unhealthy targets after draining completes;
- `HTTPCode_Target_5XX_Count` has no new datapoints;
- server and worker log streams have no new `ERROR`, `FATAL`, unhandled rejection, or out-of-memory event;
- response time remains near its pre-release baseline;
- no command or canary task remains running.

An autoscaling `AlarmLow` state is not by itself a release failure. Distinguish expected low-utilization scaling alarms from new application, target-health, or dead-letter alarms, and record the alarm's last state-change time.

## Rollback rules

- Do not blindly deploy old application code after forward-only or contracting database changes.
- Roll back application tasks only when the compatibility matrix proved the old code safe on the upgraded schema.
- Prefer roll-forward or cursor-based upgrade resume when schema rollback is unproven.
- A failed command runner is not evidence that the serving application is unhealthy. Evaluate service health and command health separately.
- Preserve the failed task, log stream, digest, and migration cursor evidence before retrying.

## Completion record

Record this evidence in the promotion PR or release record:

- source and merge commit SHAs;
- Go compatibility commit and containment proof;
- CI run and cross-version upgrade result;
- image repository, SHA tag, and immutable digest;
- server and worker task-definition revisions and final task ARNs;
- runner task-definition revision, task ARN, `startedBy`, exit code, and log stream;
- workspace success and failure totals;
- post-upgrade restart task ARNs and resolved digests;
- marketplace-sync and fresh-provisioning canary results;
- final ECS, ALB, CloudWatch, and public-health evidence;
- any known warning explicitly accepted, with owner and follow-up.

Promotion is complete only after this record is filled and every required gate above has passed.
