# Regie E2E workspace quarantine and sweep

## Safety model

Regie Go can clean up workspaces for which it retained a tenant connection,
but Twenty is the authoritative inventory when provisioning is interrupted.
Permanent deletion therefore requires durable E2E identity stored in Twenty;
names alone are not sufficient.

When Go provisions an ephemeral CRM tenant, it sends both `ephemeral: true`
and its `org_e2e_*` organization ID. Twenty accepts that marker only when the
workspace slug also starts with `org-e2e-`, then stores the organization ID and
exact workspace slug with the workspace.

## Cleanup lifecycle

`DELETE /internal/workspaces/:workspaceId` is authenticated with
`TWENTY_INTERNAL_METADATA_TOKEN`. It only soft-deletes the workspace and
flushes its metadata caches; it never performs permanent deletion. The response
calls this state `quarantined` and reports whether the workspace is eligible
for eventual purging.

The hourly sweeper independently requires all of the following before permanent
deletion:

1. The persisted marker has `ephemeral: true`.
2. Its organization ID starts with `org_e2e_`.
3. Its recorded slug exactly matches the current workspace slug.
4. The workspace slug starts with `org-e2e-`.

If any check fails, the workspace remains quarantined indefinitely. No remotely
callable endpoint performs an immediate hard delete.

Re-quarantining an already soft-deleted workspace is a no-op after marker
evaluation. In particular, it does not repeat membership removal or external
billing cancellation while asynchronous billing state is still converging.

The hourly suspended-workspace scheduler enqueues its database-intensive work
on the dedicated, single-concurrency `workspace-cleanup-queue`. The scheduler's
Sentry check-in and other cron jobs therefore do not wait behind workspace
deletion. The batch still runs under the existing distributed lock.

The generic cleaner selects at most its configured hard-deletion limit and only
loads active suspended workspaces old enough to require a warning or soft
deletion. It no longer loads every soft-deleted suspended workspace merely to
skip it after reaching the limit.

The same batch runs the E2E sweeper, which selects at most 10 workspaces that
have been quarantined for 24 hours. Its database query applies the marker,
prefix, and age checks, and the service revalidates the full marker and exact
slug in memory before calling `WorkspaceService.deleteWorkspace(workspaceId)`.
Individual failures are logged and retried on the next run.

The 10-workspace hourly batch permits 240 permanent deletions per day. A larger
failure burst intentionally drains over multiple runs; monitor the oldest
eligible quarantine before increasing the cap.

Legacy workspaces without the durable marker are deliberately excluded and
require manual review. This prevents an old or customer-created workspace from
becoming permanently deletable merely because its name resembles an E2E name.

## One-time backlog drain

Use `workspace:purge-regie-e2e-batch` to run exactly one normal, guarded E2E
sweeper batch. The command preserves the marker, organization ID, exact slug,
24-hour grace period, and 10-workspace limit; it does not expose an unbounded or
parallel deletion mode.

From the built server package, run one batch with:

```sh
yarn command:prod workspace:purge-regie-e2e-batch
```

Before each additional batch, verify that the prior command has exited and that
PostgreSQL CPU, free memory, disk queue depth, and query timeouts have recovered.
Stop the drain if workflow-cron check-ins become late, the worker restarts, or a
workspace deletion times out. A timed-out workspace remains eligible for a
later retry.
