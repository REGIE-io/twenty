# Regie E2E workspace sweep

## Why the sweep belongs in Twenty

Regie Go can clean up workspaces for which it has a tenant connection row. It
cannot discover workspaces created before that row was written, or workspaces
whose ephemeral Go database has already been destroyed. Twenty is the only
system with an authoritative inventory for those orphans.

The normal E2E lifecycle should not depend on a sweep. Go must persist a
`provisioning` connection immediately after Twenty returns the workspace and API
key, and must issue a compensating hard delete when the remainder of setup
fails. The sweep is a safety net for legacy or interrupted runs.

## Proposed scheduled sweep

Implement the sweep as a Twenty server command or worker job. It should:

1. Select workspaces whose subdomain starts with `org-e2e-` and whose creation
   time is older than a configurable grace period (initially 24 hours).
2. Exclude any workspace without the E2E prefix, regardless of age or status.
3. Log a dry-run candidate count and workspace identifiers before deletion.
4. Hard delete through `WorkspaceService.deleteWorkspace(workspaceId)` so the
   workspace schema, metadata, files, and Redis workspace caches follow the
   same cleanup path as other permanent deletions.
5. Process a bounded batch (initially 25) under a distributed lock, record
   success/failure counts, and retry individual failures on the next run.

The job should expose metrics for candidates, deleted workspaces, failures, and
oldest candidate age. Alert when failures persist or the oldest candidate age
exceeds the grace period plus one schedule interval.

## Rollout

1. Deploy the internal hard-delete endpoint and the Go lifecycle fix.
2. Run the proposed sweep in dry-run mode and compare candidates with recent
   E2E run names.
3. Manually approve the first bounded deletion batch.
4. Enable the schedule only in the Regie-managed Twenty environment.

`DELETE /internal/workspaces/:workspaceId` is guarded by
`TWENTY_INTERNAL_METADATA_TOKEN` and performs an immediate hard delete. It is
intended for the normal Go cleanup path; the future sweep should call the
service directly rather than make an HTTP request back into Twenty.
