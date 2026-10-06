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

## CI ownership and interrupted-run cleanup

Dedicated CRM CI provisioning adds `ciOwner` to the existing create request:

```json
{
  "repository": "REGIE-io/go",
  "runId": "123456789",
  "runAttempt": 1,
  "job": "crm-api-records"
}
```

Twenty records this identity with `owner: "go-crm-ci"`, `issuedAt`, and a server-issued
`expiresAt` exactly 60 minutes later in the existing `USER_VARIABLE` marker. The
request cannot choose or extend expiry. CI metadata is accepted only with
`ephemeral: true`, an `org_e2e_` organization, and an exact `org-e2e-` workspace slug.
No database migration or new feature flag is required.

The repository, run, attempt and job are immutable. Existing CI markers cannot be
rebound, renewed, or stripped by legacy marker backfill. Activation and deletion
of a marked CI workspace require the same `ciOwner` in the request body;
activation also refuses an expired lease. Instant hard deletion requires the
same identity in addition to its existing organization/slug safety inputs.
Legacy requests without CI metadata retain their existing behavior.

The existing ten-minute E2E discovery cron first quarantines up to 15 expired
`ACTIVE` CI workspaces under the `clean-suspended-workspaces-job` PostgreSQL advisory
lock. It requires the durable owner, full run identity, fixed expiry, exact slug,
and ephemeral organization; names alone never authorize cleanup. Unexpired,
legacy, malformed, and already quarantined workspaces are excluded. Failures are
logged and retried on a later pass.

Expiry authorizes quarantine, not immediate hard deletion. The existing 24-hour
quarantine grace and deletion lifecycle remain unchanged. This recovers workspaces
left by cancelled workflows or killed runners without relying on Go teardown.

## Cleanup lifecycle

`DELETE /internal/workspaces/:workspaceId` is authenticated with
`TWENTY_INTERNAL_METADATA_TOKEN`. It only soft-deletes the workspace and
flushes its metadata caches; it never performs permanent deletion. The response
calls this state `quarantined` and reports whether the workspace is eligible
for eventual purging.

The E2E deletion discovery independently requires all of the following before permanent
deletion:

1. The persisted marker has `ephemeral: true`.
2. Its organization ID starts with `org_e2e_`.
3. Its recorded slug exactly matches the current workspace slug.
4. The workspace slug starts with `org-e2e-`.

If any check fails, the workspace remains quarantined indefinitely. CI markers
also require valid ownership metadata. The separate authenticated instant-hard-delete
endpoint retains its explicit identity checks; normal `DELETE` never uses it.

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

E2E discovery runs separately every ten minutes. It admits quarantined workspaces
after 24 hours, using its configured admission limit, and recovers interrupted
deletion jobs through the existing lifecycle store. The manual sweep command
remains a bounded 15-workspace operation. Monitor backlog age before changing
these limits.

Legacy workspaces without the durable marker are deliberately excluded from
prefix-based cleanup. To migrate one, Go must look up the authoritative tenant
connection and submit its exact organization ID, Twenty workspace ID, and
derived workspace slug to
`POST /internal/workspaces/:workspaceId/e2e-marker`. Twenty verifies both E2E
prefixes, requires the supplied slug to equal the workspace's current subdomain,
and refuses to overwrite a conflicting marker. The operation is idempotent and
does not delete or quarantine the workspace.

After the marker is backfilled, Go can call the normal `DELETE` endpoint to
quarantine the workspace. This supports pre-marker inventory without allowing
an old or customer-created workspace to become permanently deletable merely
because its name resembles an E2E name.

## One-time backlog drain

Use `workspace:purge-regie-e2e-batch` to run exactly one normal, guarded E2E
sweeper batch. The command preserves the marker, organization ID, exact slug,
24-hour grace period, and 15-workspace limit; it does not expose an unbounded or
parallel deletion mode.

For pre-marker workspaces, first run Go's bounded legacy backfill and quarantine
operation. Review its exact organization/workspace mappings and failures before
running a Twenty purge batch. Never construct a deletion list from workspace
names alone.

From the built server package, run one batch with:

```sh
yarn command:prod workspace:purge-regie-e2e-batch
```

Before each additional batch, verify that the prior command has exited and that
PostgreSQL CPU, free memory, disk queue depth, and query timeouts have recovered.
Stop the drain if workflow-cron check-ins become late, the worker restarts, or a
workspace deletion times out. A timed-out workspace remains eligible for a
later retry.
