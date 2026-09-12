# Regie workspace teardown lifecycle and recovery design

Status: proposed follow-up to [Twenty PR #137](https://github.com/REGIE-io/twenty/pull/137)

Owners: Twenty workspace lifecycle and Regie CRM control plane

## Summary

Workspace teardown must become a persisted, resumable lifecycle rather than an
hourly best-effort loop. Candidate discovery, ordinary workspace lifecycle
maintenance, and destructive teardown are independent operations and must not
share one batch's success boundary.

The target architecture uses the state already persisted by Twenty and Go:

- Twenty owns the detailed execution state for deleting a Twenty workspace.
- Go owns the tenant-to-workspace control-plane lifecycle and treats every
  deprovisioning state as inactive.
- Schedulers discover work; one deterministic queue job owns one workspace.
- Every destructive phase is idempotent, checkpointed, retryable, and bounded.
- Monitoring follows the detached work through completion rather than declaring
  success when it is merely enqueued.

This requires two coordinated pull requests. The Twenty PR is additive and is
deployed first. The Go PR begins driving the extended lifecycle only after the
Twenty API and persistence model are available.

## Why this work is necessary

Regie creates short-lived Twenty workspaces for end-to-end tests. Teardown can
be skipped when a test runner is cancelled, killed, or disconnected, so a
periodic safety net is required. Historical workspaces also predate reliable
persistent E2E markers and must be cleaned up without weakening the safety
boundary that protects real tenants.

The backlog contributes work to Postgres, Redis, and scheduled workers. Merely
increasing infrastructure capacity does not fix the lifecycle: cleanup must be
able to identify eligible workspaces, remove them at least as quickly as they
are created, survive interruption, and prove that it completed.

The relevant production symptoms included:

- [TWENTY-J](https://regieai.sentry.io/issues/TWENTY-J), where the workflow cron
  monitor repeatedly reported missed check-ins while worker execution was
  unhealthy.
- [TWENTY-3](https://regieai.sentry.io/issues/TWENTY-3), which included database
  query timeout evidence in scheduled cleanup paths.
- A growing set of soft-deleted E2E workspaces which were safe to reap but were
  not being removed reliably.

The workflow-cron recovery and Redis changes improved TWENTY-J, but they do not
make workspace deletion correct. The first run of the new PR #137 cleanup path
demonstrated that these are separate concerns.

## What PR #137 changed

PR #137 added three important safety improvements:

1. It moved expensive suspended-workspace cleanup out of the shared cron queue
   into `workspace-cleanup-queue`.
2. It bounded the ordinary hard-deletion candidate selection.
3. It added a persistent E2E marker and a marker-based sweeper which only
   accepts appropriately marked, quarantined workspaces.

Those changes reduced the risk of blocking unrelated cron work and established
a safe identity boundary for E2E cleanup. They remain useful, but the combined
detached batch is not a sufficient execution model.

The PR #137 flow is currently:

```text
hourly cron
  -> enqueue CleanSuspendedWorkspacesBatchJob
       -> ordinary suspended-workspace maintenance
       -> marker-based E2E candidate query
       -> marker-based E2E deletion loop
```

The Sentry cron monitor surrounds only the first enqueue operation. It does not
surround or await the detached job.

## What happened on the first post-deployment run

The first run after PR #137 deployed began at 2026-09-12 01:00 UTC.

| Time (UTC) | Event |
| --- | --- |
| 01:00:01.235 | The hourly cron job began. |
| 01:00:01.250 | Sentry recorded the cron as successful after enqueueing. |
| 01:00:01.327 | The detached cleanup batch began. |
| 01:00:01.366 | The batch selected five ordinary hard-deletion candidates. |
| 01:00:37.853 | One workspace completed hard deletion. |
| 01:02:22.678 | The ordinary cleanup loop ended after four timeout errors. |
| 01:02:22.678 | The E2E marker candidate query began. |
| 01:02:32.681 | That query hit the primary database's 10-second query timeout. |

Only one workspace was application-confirmed as fully deleted. Of the other
four candidates:

- Two timed out during the initial workspace lookup and were probably
  untouched by that attempt.
- Two progressed through substantial metadata/schema cleanup and timed out on
  the final `DELETE FROM core.workspace`. Their final row outcome was ambiguous
  to the client, and their earlier side effects were already committed.

The marker-based E2E phase did not select or confirm any additional deletions.
No retry occurred before the next scheduled run.

This run exposed six defects in the model:

1. The monitor reported success before the operation began.
2. Independent maintenance activities shared one failure boundary.
3. One queue job looped over multiple tenants, so progress and retries were
   coarse-grained.
4. Workspace deletion was not resumable across its independently committed
   phases.
5. A client-side 10-second database timeout was applied to maintenance queries
   and writes intended to take longer.
6. Candidate and metadata deletion SQL did more work than necessary.

## Existing persisted state and ownership

This design extends existing state management rather than introducing a second
tenant lifecycle.

### Twenty workspace state

Twenty persists `workspace.activationStatus`, `deletedAt`, and `suspendedAt`.
The current activation states cover creation and access:

```text
PENDING_CREATION
ONGOING_CREATION
CREATED
ACTIVE
INACTIVE
SUSPENDED
```

Creation already uses an atomic persisted transition from `PENDING_CREATION`
to `ONGOING_CREATION`, detects a stale in-progress transition, resets retryable
failures, and treats a completed terminal state idempotently. Teardown should
follow the same pattern.

The existing states do not describe a destructive operation's current phase.
PR #137 currently selects `SUSPENDED` rows and calls `deleteWorkspace()`
directly, bypassing a persisted deletion transition.

### Go control-plane state

Go persists the tenant/workspace connection in
`crm_tenant_workspace_connections`. Its current states are:

```text
provisioning
active
blocked
disabled
```

The durable provisioning reader and organization-scoped lock already make this
the correct owner of the Regie tenant lifecycle. The existing E2E purge path
marks the connection disabled before asking Twenty to delete the workspace.
That ordering intentionally avoids an active control-plane row pointing at a
missing workspace, but `disabled` cannot distinguish:

- deletion requested but not started;
- deletion in progress;
- deletion failed and awaiting retry;
- Twenty workspace fully removed.

Go should retain high-level tenant lifecycle ownership. Twenty should retain
the detailed execution phase because only Twenty can know whether its members,
metadata, schema, caches, files, domains, and final workspace row have been
processed.

### Target state relationship

```text
Go control plane                         Twenty workspace

active                                   ACTIVE / SUSPENDED
  |                                            |
  +-- deprovisioning -----------------> PENDING_DELETION
                                               |
                                         ONGOING_DELETION
                                               |
                                      phase checkpoints
                                               |
                                        workspace removed
  |                                            |
  +-- disabled <---------------------- reconciliation

Failures remain inactive:
deprovision_failed <---------------> DELETION_FAILED
```

Pre-marker and orphaned workspaces may have no usable Go connection row.
Twenty therefore must persist enough local deletion state to finish those
workspaces safely without requiring Go to recreate missing control-plane data.

## Revised six-point implementation plan

### 1. Extend the persisted lifecycle

#### Twenty changes

Add deletion states to `WorkspaceActivationStatus`:

- `PENDING_DELETION`
- `ONGOING_DELETION`
- `DELETION_FAILED`

Add deletion execution fields to `core.workspace`:

- `deletionKind`: `E2E`, `INACTIVE`, or `MANUAL`
- `deletionPhase`: the next phase to execute
- `deletionRequestedAt`
- `deletionLastProgressAt`
- `deletionAttemptCount`
- `deletionLastErrorCode`
- `deletionLastErrorMessage`, bounded and scrubbed

Do not overload `deletedAt`. It continues to mean that a workspace has been
soft-deleted and has entered its grace period.

Candidate discovery atomically transitions an eligible workspace into
`PENDING_DELETION`. A worker atomically claims it by changing it to
`ONGOING_DELETION`. A stale claim can be reclaimed using
`deletionLastProgressAt`, matching the existing stale creation-lock pattern.

After the retry budget is exhausted, transition to `DELETION_FAILED`. A
reconciler or operator can move it back to `PENDING_DELETION` without rebuilding
lost context.

Implement the schema change through the repository's current upgrade-command
mechanism described in `UPGRADE_COMMANDS.md`; do not add a legacy TypeORM
migration.

#### Go changes

Extend the control-plane connection constraint and TypeScript types with:

- `deprovisioning`
- `deprovision_failed`

The transition becomes:

```text
active -> deprovisioning -> disabled
                       \-> deprovision_failed -> deprovisioning
```

Every state other than `active` must deny normal tenant CRM work. This preserves
the existing invariant that a deletion failure cannot leave an apparently
active tenant pointing at a damaged or missing Twenty workspace.

Go should store the Twenty deletion operation/workspace identifier and poll a
read-only internal status endpoint. It should not attempt to model Twenty's
internal teardown phases independently.

### 2. Separate discovery from per-workspace execution

Replace the combined PR #137 batch with three independent discovery jobs:

1. Inactivity warning and soft-deletion discovery.
2. Ordinary hard-deletion discovery.
3. Regie E2E hard-deletion discovery, scheduled every ten minutes.

Discovery jobs only:

1. select a bounded, deterministically ordered page;
2. validate the eligibility/safety boundary;
3. atomically set `PENDING_DELETION` when hard deletion is required; and
4. enqueue one deterministic job per workspace.

Use a deterministic job ID such as `workspace-delete:<workspaceId>`. Duplicate
discovery runs must not create concurrent teardown jobs for the same workspace.

One worker job processes one workspace. Use a workspace-scoped advisory lock,
not a single global cleanup lock. Start with queue concurrency one to measure
database impact. Increase it only when load tests and production metrics show
safe headroom.

The ten-minute schedule changes arrival latency and potential throughput; it
does not replace backpressure. If a prior job is slow, work remains queued
rather than spawning an overlapping deletion.

### 3. Make teardown phased, idempotent, and resumable

Persist the next phase after each successful phase:

```text
MEMBERS
METADATA
SCHEMA
CACHE
EXTERNAL_CLEANUP
CORE_ROW
```

Each phase must accept the state left by a previous attempt:

- Removing already-removed memberships succeeds.
- Deleting absent metadata succeeds.
- Dropping an absent workspace schema succeeds.
- Flushing absent cache keys succeeds.
- File/domain cleanup uses deterministic job IDs and is safe to enqueue again.
- DNS cleanup treats an already-absent hostname as success.
- An absent final workspace row means the teardown completed.

Advance `deletionPhase` only after the current phase has returned successfully.
Update `deletionLastProgressAt` at the same time. Capture a stable error code and
bounded message when a phase fails.

The database-backed phases should use transactions scoped to that phase. A
single transaction cannot correctly include Redis, object storage, DNS, or
queue side effects. This is a small persisted saga, not one global database
transaction.

For the final row deletion, use a server-side timeout that cancels and rolls
back the statement before the client's wait timeout. This prevents the current
ambiguous outcome where the client stops waiting without knowing whether the
database committed.

### 4. Remove avoidable SQL work and add supporting indexes

#### Field metadata deletion

The current code builds relation-aware chunks of approximately 50
`fieldMetadata` IDs and executes them sequentially because
`relationTargetFieldMetadataId` is a self-reference. A representative E2E
workspace had 609 fields and required 13 sequential statements, many taking
approximately 1.5 seconds.

Validate replacing the loop with a workspace-scoped statement:

```sql
DELETE FROM core."fieldMetadata"
WHERE "workspaceId" = $1;
```

Deleting all fields for the workspace in one statement should remove both
sides of an internal relation together. Before adopting it, tests must prove:

- paired relation fields are removed together;
- no valid cross-workspace reference is broken;
- dependent metadata foreign keys behave correctly; and
- the existing `workspaceId` index is used.

If a single statement remains too disruptive, chunk by complete relation
component rather than an arbitrary size and execute a bounded number of chunks
per phase attempt.

#### E2E discovery

Use a production-shaped `EXPLAIN` before choosing the exact index. The current
query joins `core.keyValuePair` to `core.workspace`, filters marker JSON,
filters the workspace slug and quarantine cutoff, orders by `deletedAt`, and
limits to 15.

Likely supporting indexes include:

- a selective partial index for the E2E marker key/type and `workspaceId`;
- expression predicates for stable JSON marker fields if JSON remains the
  storage format; and
- an index supporting workspace deletion eligibility and oldest-first ordering.

Prefer persisted typed marker columns if the query cannot be made reliably
selective. Do not weaken the marker plus slug plus quarantine validation in
order to make the query faster.

All candidate queries must be bounded and deterministically ordered.

### 5. Give maintenance work appropriate limits and recovery

The deployed worker does not override `PG_DATABASE_PRIMARY_TIMEOUT_MS`, so the
core datasource uses the global 10,000 ms client-side query timeout. That
interactive guardrail is not an appropriate contract for workspace teardown.

Use a maintenance query runner with explicit, separately configured limits:

- a longer Postgres `statement_timeout` for destructive maintenance statements;
- a short `lock_timeout` so cleanup yields rather than waiting behind live work;
- a client timeout longer than `statement_timeout`;
- an overall phase deadline; and
- an overall per-workspace job deadline.

Do not increase the global primary database timeout.

Configure bounded automatic retries with exponential backoff and jitter.
Differentiate retryable database pressure, lock contention, and infrastructure
errors from permanent safety-validation failures. Permanent marker failures
move directly to `DELETION_FAILED` and require review.

BullMQ lock renewal must remain healthy for teardown jobs that exceed the
30-second base lock duration. A worker restart or lost lock must result in one
stalled/retried job, not concurrent deletion.

### 6. Monitor and reconcile the complete lifecycle

Keep scheduler monitoring, but give each detached operation its own truth:

- discovery started/completed/failed;
- candidates selected;
- workspaces marked pending;
- per-workspace jobs queued/running/completed/failed;
- attempts and current phase;
- duration by phase;
- oldest pending workspace;
- total eligible and failed backlog; and
- confirmed deletions per hour/day.

Do not use workspace ID as an unbounded metric dimension. Put it in structured
logs and traces; aggregate metrics by deletion kind, phase, status, and error
code.

Sentry check-ins for a discovery cron must cover discovery, not just enqueueing
another batch. Per-workspace failures must create actionable error events. Add
CloudWatch alarms for:

- no completed E2E teardown during a period with eligible backlog;
- backlog age or size above threshold;
- elevated `DELETION_FAILED` transitions;
- workspace deletion job failures/stalls; and
- phase duration approaching its deadline.

Add a periodic reconciler which:

1. re-enqueues stale `PENDING_DELETION` rows;
2. reclaims stale `ONGOING_DELETION` rows;
3. confirms that a missing Twenty row is complete;
4. moves matching Go connections from `deprovisioning` to `disabled`;
5. moves exhausted failures to the explicit failed states; and
6. reports safe pre-marker orphans which still require a one-time reviewed
   backfill rule.

## API contract between Go and Twenty

Twenty should expose authenticated internal operations equivalent to:

```text
POST /internal/workspaces/:workspaceId/deletion
GET  /internal/workspaces/:workspaceId/deletion
```

The request identifies deletion kind and supplies the E2E safety identity when
applicable. Repeated requests are idempotent and return the same operation.

The status response exposes only lifecycle information needed by Go:

- workspace ID;
- lifecycle status;
- current phase;
- attempt count;
- last progress timestamp;
- stable error code; and
- whether the workspace is absent/completed.

Go transitions the connection to `deprovisioning` before making the request.
If the call fails, the durable poller retries. When Twenty reports the row
absent or complete, Go transitions to `disabled`.

Twenty's autonomous E2E reconciler continues to support orphaned workspaces
which cannot be reached from a live Go connection row.

## Test strategy

Testing must reproduce the ways the current implementation failed. Happy-path
unit tests alone are not sufficient.

### State-transition tests

Test the complete Twenty transition table:

- only eligible states can become `PENDING_DELETION`;
- only one worker can claim a workspace;
- a fresh `ONGOING_DELETION` claim cannot be stolen;
- a stale claim can be reclaimed;
- completed phases cannot move backwards;
- retry exhaustion produces `DELETION_FAILED`;
- an absent workspace is idempotent success; and
- ordinary workspaces cannot enter the E2E path without the persistent marker,
  matching slug, and quarantine period.

Test the Go transition table and verify that `deprovisioning`,
`deprovision_failed`, `blocked`, and `disabled` all deny normal tenant work.

### Database integration tests

Use the repository's isolated Postgres integration-test environment with
explicit environment configuration.

Seed production-shaped workspaces with:

- at least 600 field metadata rows;
- paired relation fields and morph relations;
- representative indexes, views, roles, agents, and application metadata;
- multiple workspace members;
- E2E marker rows; and
- unrelated real-tenant rows which must remain untouched.

Verify that workspace-scoped field deletion removes all and only the target
workspace's fields in one statement or in the chosen bounded relation-aware
strategy. Verify transaction rollback when any dependent deletion fails.

Seed at least the current backlog order of magnitude for the marker query.
Assert that it returns only the oldest 15 eligible rows, refuses malformed
markers, and uses the intended indexes. Record the query plan in the test
artifact. Avoid a brittle wall-clock assertion in ordinary CI; run a bounded
performance lane against production-shaped data.

### Deterministic timeout reproduction

Provide failure injection at every phase. Tests must be able to throw the same
`Query read timeout` class seen in the incident from:

- initial workspace lookup;
- metadata deletion;
- final workspace deletion; and
- E2E marker selection.

For the maintenance timeout integration test, hold a conflicting database lock
or execute an isolated intentionally slow statement under a very small
server-side timeout. Assert that Postgres cancels and rolls back before the
client timeout fires.

Specifically reproduce the first run's outcomes:

1. One workspace completes.
2. A second fails before any destructive phase.
3. A third fails after metadata/schema phases but before the final row.
4. The worker continues processing independent jobs.
5. Each failed workspace retains its exact next phase and error.
6. A retry or worker restart resumes and completes without duplicating harmful
   external side effects.

### Worker interruption and queue tests

Terminate the worker after each persisted phase boundary and start a new
worker. Wait for commands and workers to exit or reach an asserted terminal
state; starting a worker is not proof of recovery.

Verify:

- deterministic job IDs prevent duplicate active jobs;
- advisory locking prevents concurrent teardown for one workspace;
- lock renewal supports a job longer than 30 seconds;
- a genuinely stalled job is retried within the configured budget;
- retries use backoff rather than a tight loop;
- one workspace failure does not fail discovery or another workspace job; and
- queue depth remains bounded when discovery runs every ten minutes.

### Monitoring tests

Reproduce the PR #137 monitoring gap directly:

1. Allow discovery/enqueue to succeed.
2. Force the detached workspace job to fail.
3. Assert that discovery is recorded as successful.
4. Assert separately that the workspace deletion failure metric, structured
   error, lifecycle state, and alarm input are emitted.

Also test the inverse: a successful queue operation must not count as a
confirmed workspace deletion until the final row is gone.

Verify that a backlog with no successful deletions becomes alertable even when
no individual job throws, such as repeated lock contention or safety skips.

### Go/Twenty contract tests

Run contract tests across both PRs:

- repeated deletion requests return one operation;
- Go remains `deprovisioning` while Twenty reports pending/running;
- a retryable Twenty failure becomes `deprovision_failed` without reactivating
  the tenant;
- a later retry can return to `deprovisioning` and complete;
- a missing Twenty workspace is reconciled to `disabled`;
- a stale or missing Go row does not prevent Twenty from safely reaping a
  persistently marked orphan; and
- a non-E2E workspace cannot be deleted through the E2E route.

### Capacity and live-development acceptance test

Before enabling the ten-minute schedule, create a scoped set of disposable,
persistently marked development workspaces and allow them to cross the test
quarantine boundary.

Acceptance requires direct evidence that:

- every discovery run finishes and is monitored;
- every workspace reaches a terminal result;
- the eligible backlog decreases;
- successful deletion capacity exceeds the measured E2E creation rate;
- Postgres CPU, connections, latency, locks, and disk queue remain healthy;
- Redis queue locks renew without stalls;
- no TWENTY-J regression occurs;
- timeout and deletion issues do not recur in Sentry; and
- malformed or unmarked workspaces remain untouched.

Inspect at least one deliberately interrupted deletion and prove that it resumes
from the persisted phase after a worker restart.

## Backfill and recovery of existing workspaces

Deployment must include an explicit recovery pass for state created before the
new lifecycle:

1. Identify PR #137-era workspaces with valid persistent markers.
2. Identify older candidates using the reviewed one-time boundary and safety
   evidence; do not weaken the ongoing automatic marker rule.
3. Inspect the two workspaces that timed out on their final core-row deletion
   and determine whether the row still exists.
4. For surviving partial workspaces, infer the earliest safe resumable phase
   from direct database/schema evidence and store it.
5. Mark untouched eligible workspaces `PENDING_DELETION`.
6. Run the new worker at concurrency one and verify each result by readback.

The backfill must support dry-run output with counts and identifiers, require an
explicit apply mode, and be safe to repeat.

## Pull request and rollout order

### PR 1: Twenty

Scope:

- additive lifecycle states and columns;
- internal deletion request/status contract;
- independent discovery jobs;
- deterministic per-workspace teardown jobs;
- resumable phase executor;
- maintenance-specific timeout handling;
- field metadata deletion improvement;
- E2E discovery indexes;
- metrics, structured logs, and reconciler; and
- dry-run backfill/recovery command.

Deploy this PR with automatic discovery disabled or still at the conservative
cadence. Run migrations, inspect query plans, exercise the failure tests, and
perform a scoped development recovery before enabling ten-minute discovery.

### PR 2: Go

Scope:

- additive control-plane status migration;
- state types and store transitions;
- inactive behavior for all deprovisioning states;
- idempotent Twenty deletion request client;
- durable deletion status reconciliation;
- lifecycle metrics and operator readback; and
- contract coverage against the Twenty API.

Deploy only after the Twenty contract is live. Then enable Go-driven
deprovisioning and verify state convergence.

### Final cutover

After both PRs are healthy:

1. Enable E2E discovery every ten minutes.
2. Run the reviewed one-time legacy backfill.
3. Monitor backlog slope and database health through multiple cycles.
4. Retire the combined `CleanSuspendedWorkspacesBatchJob` path from PR #137.
5. Keep the safety marker, quarantine rule, and bounded candidate selection.

## Definition of done

This work is complete when:

- no monitor can report teardown success merely because work was enqueued;
- ordinary lifecycle maintenance and E2E reaping cannot fail each other;
- one workspace failure cannot stop another workspace;
- every in-progress deletion has a persisted state and next phase;
- interruption at every phase is demonstrably recoverable;
- database timeouts have determinate rollback behavior;
- successful teardown throughput exceeds workspace creation throughput;
- Go and Twenty converge to terminal state after retries;
- current and historical safe E2E backlog is decreasing; and
- no unmarked or non-E2E workspace can enter the automated E2E deletion path.
