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

The existing hourly suspended-workspace cleanup job also runs the E2E sweeper
under its distributed lock. The sweeper selects at most 10 workspaces that have
been quarantined for 24 hours. Its database query applies the marker, prefix,
and age checks, and the service revalidates the full marker and exact slug in
memory before calling `WorkspaceService.deleteWorkspace(workspaceId)`.
Individual failures are logged and retried on the next run.

The 10-workspace hourly batch permits 240 permanent deletions per day. A larger
failure burst intentionally drains over multiple runs; monitor the oldest
eligible quarantine before increasing the cap.

Legacy workspaces without the durable marker are deliberately excluded and
require manual review. This prevents an old or customer-created workspace from
becoming permanently deletable merely because its name resembles an E2E name.
