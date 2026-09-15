# Regie Workspace Schema Change Guide

This guide is the implementation companion to
[REGIE-io/go#1988](https://github.com/REGIE-io/go/pull/1988). It explains how a
Regie workspace schema change becomes part of every new workspace, how the same
change is applied to existing workspaces, and how to prove that a deployed
release converged safely.

Use this guide for objects, fields, relations, indexes, views, and other metadata
that every Regie workspace must contain. For the underlying command framework,
see [UPGRADE_COMMANDS.md](./UPGRADE_COMMANDS.md). For the complete ECS operating
procedure, see [REGIE_ECS_UPGRADE_RUNBOOK.md](./REGIE_ECS_UPGRADE_RUNBOOK.md).

## Ownership boundary

Twenty owns the workspace schema. Go may depend on a released schema version and
may run record-data backfills after that version is installed, but it must not be
the long-term owner of metadata creation or reconciliation.

| Concern                                                                  | Owner             |
| ------------------------------------------------------------------------ | ----------------- |
| Standard object, field, relation, index, and view definitions            | Twenty            |
| New-workspace schema installation                                        | Twenty            |
| Existing-workspace schema upgrade and durable cursor                     | Twenty            |
| Upgrade serialization and status calculation                             | Twenty            |
| ECS task definitions, immutable image selection, and deployment workflow | Go infrastructure |
| Product record-data backfills after the schema exists                    | Go                |
| Product code that consumes the new schema                                | Go                |

## Part 1: Add or alter schema for every workspace

Every change has two paths that must land in the same Twenty release:

1. **New workspaces:** update the compiled standard-application metadata so a
   workspace created by the new release is born with the target schema.
2. **Existing workspaces:** register a workspace upgrade command that moves the
   prior schema to the target schema and records its durable cursor.

Implementing only one path creates permanent fleet drift.

### 1. Classify the change

- **Additive:** add the entity to the standard application and add a workspace
  command for existing workspaces. Keep the prior Go release compatible.
- **Behavior-preserving alteration:** retain stable universal identifiers and
  change only the attributes supported by the metadata migration engine.
- **Contracting or destructive:** use expand, migrate, and contract releases.
  Stop old consumers before removing or narrowing schema.
- **Core/instance schema:** use an instance command when the change affects the
  shared `core` or `metadata` database schema rather than one workspace.

Do not encode a destructive transition as an incidental reconciliation step.

### 2. Update the new-workspace source of truth

Change the appropriate builders under:

```text
packages/twenty-server/src/engine/workspace-manager/
  twenty-standard-application/
```

Add objects, fields, relations, indexes, and views to the same standard metadata
maps used during workspace creation. Assign stable universal identifiers and
derive related identifiers using existing standard-application helpers. Do not
generate identifiers at runtime or copy database IDs from one workspace.

Test that a newly created workspace contains the complete target shape. Include
implicit side effects such as relation fields, search metadata, and backing
indexes in the assertions.

### 3. Add the existing-workspace command

Create a registered workspace command in the current version directory under:

```text
packages/twenty-server/src/database/commands/upgrade-version-command/<version>/
```

Register it in that version's module and use both decorators:

```ts
@RegisteredWorkspaceCommand('2.x.0', 1780000000000)
@Command({
  name: 'upgrade:2-x:install-regie-schema-change',
  description: 'Install the Regie schema change in existing workspaces',
})
```

Build a metadata migration matrix and execute it through
`WorkspaceMigrationValidateBuildAndRunService`. For commands targeting 2.19 or
later, use `validateBuildAndRunWorkspaceMigration` so the standard side-effect
engine creates and validates engine-owned companions. Use the legacy entrypoint
only for a historical command that was originally authored before 2.19.

The command must be:

- idempotent after interruption;
- safe when the target entity already exists in the expected shape;
- fail-closed when an existing entity conflicts with the stable universal
  identifier or expected shape;
- scoped to the workspace supplied by the runner;
- explicit about any record-data migration that cannot be transactional.

Never edit the `up` or `down` behavior of a previously shipped command to change
history. Add a new repair command instead.

### 4. Handle adoption

When Twenty assumes ownership of metadata previously created by Go, the first
workspace command is an adoption command. It must:

1. locate the existing entities by durable identity and expected shape;
2. validate compatibility before writing;
3. assign the standard application's universal identifiers and ownership;
4. preserve metadata IDs, physical tables, indexes, and customer records;
5. fail the workspace for manual repair when the shape is ambiguous.

Do not delete and recreate customer schema merely to normalize ownership.

### 5. Prove both paths converge

At minimum, test:

- a fresh workspace created from the target release;
- an existing workspace upgraded from the prior release;
- an interrupted command resumed from its durable cursor;
- an already-current workspace rerun as a safe no-op;
- a conflicting legacy shape failing closed;
- both old/new application overlap directions against a production-like
  database snapshot;
- fresh workspace creation during the tested rollout order;
- schema and metadata readback after cache refresh.

Both the fresh and upgraded workspace must resolve to the same stable universal
identifiers and physical constraints.

### 6. Remove the old Go writer last

After Twenty creates the schema for new workspaces and every existing workspace
has completed the adoption/upgrade command:

1. run any Go-owned record backfills;
2. deploy Go without the metadata creation calls;
3. keep read-only readiness checks for one release window;
4. remove the old reconciliation endpoints only after telemetry remains clean.

## Part 2: Deploy and verify the schema system

### 1. Establish the release contract

Record the exact Twenty commit, immutable image digest, target schema change,
expected final command, supported workspace count, and compatible Go commit.
Run the cross-version matrix before touching an environment. If neither old nor
new code tolerates the overlap, split the release.

### 2. Keep service tasks migration-disabled

Every long-lived server and worker task must set:

```text
DISABLE_DB_MIGRATIONS=true
```

The upgrade runner also sets `DISABLE_CRON_JOBS_REGISTRATION=true`. Do not enable
startup migrations on one replica as a shortcut: rolling deploys and autoscaling
can start several replicas concurrently.

### 3. Select the compatibility-tested order

- If new code tolerates the old schema, roll and drain the serving fleet first,
  then run the upgrade.
- If old code tolerates the expanded schema, run the upgrade first, then roll
  the serving fleet.
- If neither is true, stop and create separate expand, migrate, and contract
  releases.

The runner, server, and worker must use the same immutable image digest.

### 4. Run exactly one upgrade sequence

Launch one non-load-balanced command task with the production-proven resource
profile documented in the ECS runbook and run:

```bash
node dist/command/command upgrade --verbose
```

The command holds a PostgreSQL advisory lock named `twenty:upgrade-sequence` for
the entire sequence. A second runner exits nonzero before reading or changing
the sequence. Workflow concurrency and the pre-launch ECS task check remain
defense in depth; the database lock is the final cross-host guard.

Record the task ARN, task-definition revision, image digest, `startedBy`, log
stream, start time, expected workspace count, and final summary.

### 5. Gate on machine-readable health

After the upgrade task exits `0`, run the status command from the same immutable
image:

```bash
node dist/command/command upgrade:status \
  --failed-only \
  --fail-on-unhealthy
```

`--fail-on-unhealthy` exits nonzero when the instance or any selected workspace
is behind or failed. Without that flag, `upgrade:status` remains a report-only
operator command for backward compatibility.

The promotion gate requires:

- runner container exit code `0`;
- zero failed and zero behind workspaces;
- the expected workspace count at the final cursor;
- no fatal, out-of-memory, aborted, or lock-conflict event;
- a final convergence check that includes workspaces created during overlap.

### 6. Refresh every serving process

Flush the shared cache after a successful upgrade, then restart both server and
worker services on the same digest. Require one completed primary deployment,
desired count equal to running count, zero pending tasks, and healthy load
balancer targets.

The restart is mandatory because shared cache invalidation does not rebuild all
process-local upgrade-aware metadata.

### 7. Run canaries and observe

Verify both an existing workspace and a fresh ephemeral workspace:

- schema version/cursor and metadata readback;
- expected objects, fields, relations, indexes, and views;
- representative record create, update, query, and delete behavior;
- Go API key/member provisioning and any product-specific readiness checks;
- safe cleanup of the ephemeral workspace.

Observe server, worker, and runner logs plus Sentry, CloudWatch, Redis, database,
ECS, and load-balancer health for at least ten minutes. Specifically reject new
metadata-cache misses, duplicate indexes, upgrade failures, or provisioning
errors. A quiet window is evidence for the tested release, not proof that an
untested race cannot recur.

## Recovery

If the runner fails, do not launch another task until the first task is stopped
and its exit code, logs, and final cursor are captured. Correct the execution
constraint, then rerun the same immutable image; durable command cursors skip
completed work. If status remains behind or failed, block the dependent Go
release and follow the recovery section of the ECS runbook.
