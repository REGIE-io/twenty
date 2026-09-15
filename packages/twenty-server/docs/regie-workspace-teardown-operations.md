# Regie E2E workspace teardown operations runbook

This is the handoff checklist for deploying and validating Twenty PR #138 with
Go/Pulumi PR #2202. It describes the normal signals observed in the restored
development-database runs and the conditions that must stop a rollout.

## Scope and safety boundary

PR #138 owns discovery and resumable deletion inside Twenty. Merged and applied
PR #2202 supplies the server/worker environment (`cron disabled`, recovery
limit 5, admission limit 15), CloudWatch log metrics, alarms, and the dashboard.
It does not own workspace state or Go lifecycle reconciliation.

Only a workspace with all of the following can enter automatic E2E discovery:

- the exact persistent E2E marker key and type;
- marker `ephemeral: true`;
- an `org_e2e_...` marker organization ID;
- an `org-e2e-...` workspace subdomain;
- marker workspace slug equal to that subdomain; and
- `deletedAt` older than the current 24-hour reaper policy.

The internal `instant-hard-deletion` endpoint deliberately bypasses the
`deletedAt` grace check for an active or suspended E2E workspace, but requires
the same exact identity and an internal metadata token. It is not a general
workspace deletion API. Ordinary suspended customer cleanup remains on the
unchanged `WorkspaceService.deleteWorkspace()` batch path.

## Deployment order

1. PR #2202 is already merged and applied with recovery `5`, admission `15`,
   and the cleanup cron disabled.
2. The IAM hardening in PR #2221 has been applied manually. PR #2221 makes
   that state authoritative and must merge before another Pulumi apply, but the
   live equivalent permissions mean it does not block #138.
3. Merge and build Twenty #138.
4. Before starting the new Twenty image, the deployment runs its one-off
   upgrade task followed by the strict status gate:

   ```bash
   yarn command:prod upgrade
   yarn command:prod upgrade:status --failed-only --fail-on-unhealthy
   ```

   This is the normal Twenty upgrade-command mechanism. The deployment aborts
   if either command fails, before either long-lived service is rolled.

5. Roll the Twenty server and worker and wait for both services to stabilize.
6. Run and verify the native ECS-to-CloudWatch observability canary.
7. Leave the cleanup cron disabled. Validate limited quarantine/backfill,
   direct reaper execution, logging, alarms, and Sentry before enabling it in a
   separate reviewed Pulumi change.

The schema addition is forward-compatible, but changing a restored test copy
is a one-way migration unless it is restored from its snapshot.

## Database preflight

Snapshot any copied database before the upgrade. Record the snapshot ID, RDS
endpoint, Twenty image SHA, both PR SHAs, and the UTC start time.

Before mutation, count:

- exact marker-safe E2E workspaces;
- marker-safe rows already soft-deleted;
- active marker-safe rows eligible for backfill;
- non-E2E workspace count and an ordered-ID fingerprint;
- existing `PENDING_DELETION`, `ONGOING_DELETION`, and `DELETION_FAILED` rows;
- target workspace schemas, memberships, object/field metadata, and key values.

Stop if any selected marker is malformed or ambiguous, or if unrelated
deletion lifecycle rows would make the expected 5 + 15 inventory uncertain.

## Quarantine existing E2E workspaces

Always run limited dry-run, limited apply, all dry-run, and all apply in that
order. For example:

```bash
yarn command:prod workspace:backfill-regie-e2e-quarantine \
  --organization-ids org_e2e_one,org_e2e_two
yarn command:prod workspace:backfill-regie-e2e-quarantine \
  --organization-ids org_e2e_one,org_e2e_two --apply
yarn command:prod workspace:backfill-regie-e2e-quarantine --all
yarn command:prod workspace:backfill-regie-e2e-quarantine --all --apply
```

Normal output reports candidates, already-quarantined rows, selected IDs, and
applied rows. A repeated dry-run after all-mode apply must report zero new
candidates. A limited apply with a missing or non-unique organization must fail
the whole request. Read back the selected IDs and confirm all unselected E2E
and non-E2E controls are unchanged.

Observed on the 2026-09-14 restored dev copy:

- 66 exact marker-safe workspaces and zero malformed matches;
- 36 already quarantined and 30 requiring backfill;
- limited mode changed exactly 2 and left the other 28 plus 3,147 controls
  unchanged;
- all mode changed the remaining 28 and a repeated dry-run returned zero;
- 66 became grace-eligible under a test-only future clock.

The pre-reaper recovery point is RDS snapshot
`twenty-pr138-post-backfill-pre-reaper-20260914-1915`.

## Direct reaper validation

Use the direct acceptance lane before registering the repeatable cron. It uses
the real database, Redis/BullMQ adapter, lifecycle state, advisory lock, and
single-concurrency worker:

```bash
NODE_OPTIONS=--max-old-space-size=12288 \
RUN_WORKSPACE_DELETION_DIRECT_ACCEPTANCE=true yarn jest \
  --config jest-integration.config.ts \
  test/integration/workspace-deletion/workspace-deletion-direct-acceptance.integration-spec.ts \
  --runInBand
```

For a restored backlog, the opt-in backfill/reaper acceptance lane drains
bounded rounds and independently checks the target-owned rows:

```bash
RUN_WORKSPACE_DELETION_BACKFILL_REAPER_ACCEPTANCE=true yarn jest \
  --config jest-integration.config.ts \
  test/integration/workspace-deletion/workspace-deletion-backfill-reaper-acceptance.integration-spec.ts \
  --runInBand
```

The restored-backlog lane allows up to three times the deletion-job timeout
without a visible BullMQ state change, while retaining a ten-minute hard limit
for each bounded round. A production-sized metadata phase can otherwise outlive
the shorter direct-fixture stall check even while it is making database
progress.

Normal discovery admits no more than 5 recoveries plus 15 fresh rows. Each
workspace logs `workspace_deletion_started`, phase started/finished pairs, and
one `workspace_deletion_finished` with `result: completed`. A successful final
readback has no target workspace rows, schemas, memberships, object metadata,
field metadata, marker key values, or outstanding lifecycle rows. The control
count and fingerprint must be unchanged.

An intentional interruption is normal only when planned: completed phases stay
checkpointed, stale `ONGOING_DELETION` rows are recovered before fresh work,
and the next worker finishes from the stored phase. A retryable fast failure is
returned immediately to `PENDING_DELETION`, so BullMQ's retry does not wait for
the stale-worker window.

Observed restored-copy drain: an interrupted first 15 were recovered on worker
restart; the remaining 51 were admitted as 15/15/15/6; all 66 targets and all
owned rows were removed; all 3,147 controls, including 1,438 pre-existing
soft-deleted controls, remained.

The 2026-09-14 full pre-harness restoration repeated the complete path from
snapshot `twenty-pr138-dev-copy-pre-harness-20260913-1734`. It found 86 exact
marker-safe workspaces: 56 already quarantined and 30 requiring backfill. The
limited canary changed exactly 2, all-mode changed the remaining 28, and the
repeat dry-run reported 0 candidates and 86 already quarantined. The first
upgrade pass surfaced one workspace query timeout and exited non-zero after
1,738 successes; an idempotent retry completed all 1,739 workspaces with no
failures.

The reaper then removed all 86 targets. During the run, terminating the active
PostgreSQL backend in `METADATA` produced a retryable `QUERYFAILEDERROR`; attempt
2 resumed from `METADATA` and completed. A separate `SIGKILL` left another row
at `METADATA`, attempt 1; a compiled production worker reclaimed the stalled
BullMQ job and completed the surviving batch without manual database or queue
repair. The final acceptance segment drained 41 rows as 15/15/11 and reported
zero remaining schemas, memberships, object metadata, field metadata, or key
values. The 3,147-workspace control fingerprint remained
`233dd26483ae522cadfbf265ce8ea6d5`, with no outstanding lifecycle or deletion
queue rows.

On the restored `db.t4g.large`, the 42-minute reaper/chaos window started with
5.033 GB FreeableMemory, ranged from 4.978 to 5.035 GB, and ended at 4.980 GB.
The quiet sample five minutes later recovered to 5.008 GB. SwapUsage remained
exactly zero. Database connections peaked at 11 only while a worker process
existed and its pool was released on shutdown; CPU peaked at 55.01% and
DiskQueueDepth at 1.17. This larger instance is not an absolute capacity proxy
for the production `db.t4g.medium`, but the bounded range, released backends,
and zero swap show none of the monotonic memory/connection ratchet associated
with the previous hourly sweeper.

After the lifecycle-only relation-safe batching change, the PostgreSQL lane was
rerun against the same restored copy. It deleted 600 paired fields in committed
batches while preserving all 10 fields in the control workspace; the complete
fixture/test case took 354 ms. The catalog cleanup and internal HTTP safety
integration suites also passed (6 tests), including active exact-E2E acceptance,
non-E2E refusal, and removal of the target schema and owned catalog rows. The
historical 20-workspace result below remains the end-to-end capacity baseline;
repeat that full lane before production enablement if the deployed SHA differs.

## Real cron validation

For the cron acceptance lane, set the cron environment to true and add
`WORKSPACE_DELETION_ACCEPTANCE_VIA_CRON=true` to the direct acceptance command.
The test registers the real `*/10 * * * *` BullMQ repeat, waits for the firing,
removes the repeat after discovery, and starts its ten-minute budget at the
observed discovery event. It must not call the processor directly.

A healthy pass shows, in order:

1. `workspace_deletion_discovery_started`;
2. `workspace_deletion_discovery_finished` with recovered/admitted counts;
3. per-workspace and per-phase events;
4. `workspace_deletion_finished` for every successful target; and
5. `workspace_deletion_backlog_snapshot` with no stalled, terminal, or old
   work once the pass drains.

The restored-copy cron run recovered 5 and admitted 15. It removed all 20 in
474.559 seconds after discovery, leaving 125.441 seconds before the next
schedule. Mean workspace duration was 23.732 seconds, population standard
deviation 10.387 seconds, and mean + 2σ 44.506 seconds. RDS CPU averaged
44.34%, peaked at 52.67%, connections peaked at 4, and latency/disk queue stayed
low. Treat materially worse results or failure to drain before ten minutes as
a stop condition; do not increase concurrency or admission limits during the
same validation.

## CloudWatch and Sentry

In the deployed worker log group, verify native ECS `awslogs` delivery from the
exact worker task/stream; replayed validation events do not satisfy this check.
The infrastructure namespace is `<stack-prefix>/Twenty`. A healthy run should
increment:

- `WorkspaceDeletionDiscoveryHeartbeat`;
- `WorkspaceDeletionDiscoveryRun`; and
- `WorkspaceDeletionCompleted` once per completed workspace.

It should not increment discovery failure, deletion failure, stalled backlog,
terminal backlog, or old backlog metrics. The `<stack-prefix>-twenty-workspace-deletion`
dashboard should show the same values. When cron is enabled, the missing
heartbeat alarm expects at least one snapshot in each ten-minute period and
alarms after two missing periods. Inject canary events only in a validation
stack and confirm each corresponding alarm changes state, then returns to OK.

Native ECS transport was demonstrated with an exact task ID and stream in
`/ecs/twenty-crm-dev-server`; the deployment validation must repeat this on the
actual worker stream because that is where deletion events originate.

For Sentry, cause a labelled validation exception, record the 32-character
event ID returned by Twenty, wait for flush success, and run #2202's
`Validate Sentry event receipt` workflow with a read-only `SENTRY_AUTH_TOKEN`.
The workflow must resolve the same event ID. Submission plus flush alone is not
receipt proof; the restored-copy run reached submission/flush, while independent
API readback remained outstanding.

## Stop, recover, and declare success

Disable cron admission first if errors appear. Do not kill a database phase
until its server-side statement has ended; the worker retains the advisory lock
while an operation settles so a retry cannot overlap it. Restarting the worker
should recover stale or pending rows from their stored phase. Restore the RDS
snapshot if the upgrade or safety inventory itself is wrong.

Declare the rollout healthy only after multiple cron cycles show:

- exact E2E-only selection and unchanged controls;
- 5 + 15 bounded admission and completion inside ten minutes;
- complete database/schema/external cleanup;
- decreasing or empty eligible backlog;
- completion counts equal independently missing workspace rows;
- healthy RDS and Redis behavior;
- native worker logs, CloudWatch metrics/alarms, and Sentry receipt; and
- successful interruption/recovery without overlapping mutation.

Ordinary suspended-workspace reliability and Go lifecycle readback/reconciliation
remain explicit follow-ups; they are not provided by #138/#2202 phase one.
