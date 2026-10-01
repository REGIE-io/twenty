# Allow duplicate CRM identities

`person.emails` and `company.domainName` are non-unique. Their existing standard
indexes remain as lookup indexes, including their historical names and universal
identifiers. Twenty's create-many upsert conflict discovery now uses the record ID
instead of the email/domain. Other unique constraints are unchanged.

The versioned command `upgrade:2-32:allow-duplicate-crm-identities` reconciles both
index metadata and the physical indexes in one transaction per provisioned workspace.
It rebuilds missing/invalid indexes, supports reruns, and refreshes metadata caches
and the workspace metadata version after commit. A 5-second lock timeout rolls back
the current workspace if another workload holds the table. Field uniqueness is derived
from index metadata during cache rebuild; no persisted field flag is updated.
The upgrade preserves index identity and columns as a non-unique lookup, and skips
standard objects absent from partially provisioned workspaces.

From the built twenty-server container:

```sh
node dist/command/command.js upgrade:2-32:allow-duplicate-crm-identities --workspace-id <workspace-id> --dry-run
node dist/command/command.js upgrade:2-32:allow-duplicate-crm-identities --workspace-id <workspace-id>
```

First validate in an isolated workspace. Deploy Go's duplicate-protection guards
([Go #2622](https://github.com/REGIE-io/go/pull/2622)) before removing Twenty uniqueness.
Deploy Twenty server/worker and apply across provisioned workspaces, then enable
provider-ID-only CRM imports after the Go importer from
[Go #2615](https://github.com/REGIE-io/go/pull/2615) reaches the target environment.
No global write pause is planned: inspect the canary's lock contention and retry
workspaces whose transaction hits the five-second lock timeout. Omitting
`--workspace-id` selects the provisioned workspace fleet. Explicitly invoke this command for an instance already
at 2.32 if its normal upgrade runner does not revisit that version.

Verify field and index metadata are non-unique, and inspect `pg_index` for valid,
non-unique physical indexes on `person.emailsPrimaryEmail` and
`company.domainNamePrimaryLinkUrl`. Verify two distinct IDs with the same values
persist and an ID replay updates only its row. The Go importer permits distinct CRM
source IDs to share these values. Go-origin manual, bulk, chat, and CSV creation retain
their duplicate rejection/reuse rules;
native Twenty API/UI creation permits duplicate values.

After duplicates exist, restore neither the old unique indexes nor Go's old fallback
matching automatically. Pause inbound workers and fix forward. Reinstating uniqueness
requires separate data reconciliation; the migration never deletes or merges rows.

## Tests

Run the focused Jest suite normally for the new-workspace metadata/upsert contract.
For PostgreSQL migration, dry-run, rerun, and rollback checks, set
`CRM_DUPLICATES_TEST_DATABASE_URL` to a **disposable database**. The test creates its
own random workspace schema and two minimal metadata tables; do not use a customer DB.

```sh
CRM_DUPLICATES_TEST_DATABASE_URL=<disposable-postgres-url> yarn jest --config packages/twenty-server/jest.config.mjs --runInBand --runTestsByPath packages/twenty-server/src/database/commands/upgrade-version-command/2-32/__tests__/allow-duplicate-crm-identities.command.spec.ts
```

## Shared-address history

People sharing primary or additional emails remain distinct. Participant matching
normalizes exact addresses and assigns a convenience person ID only when one live
person matches; primary email does not outrank another person's additional email.
Soft-deleted people cannot take the match.

Email/calendar timeline reads include exact shared addresses without copying activity
rows or broadening channel visibility. The address branch requires a mailbox channel
association; direct record associations remain independent. Company timelines derive
people from explicit relationships, never shared domains. Twenty frontend code is
unchanged: this PR adds no history labels or periodic refresh. Shared history is
returned when the existing timeline queries run.

The current Go scope is CRM imports only, with canonical `externalCrmId` matching
and preserved Go-origin duplicate rules. Go #2502 is closed. Go #2615 contains the
importer and recovery tooling; Go #2622 backports CSV/edit guards to `main`.
No Go control-plane/backend migration is required for those changes. Historical
merges and existing associations are preserved.

## Shared-address timeline lookup indexes

`upgrade:2-32:add-participant-handle-indexes` adds non-unique B-tree expression
indexes on `LOWER(TRIM(handle))` for the standard `messageParticipant` and
`calendarEventParticipant` tables. These support the shared-address branch of
both timeline count and page queries alongside the existing person-ID indexes.

Index metadata currently describes field columns, not SQL expressions. These two
physical indexes are therefore owned by `ensureParticipantHandleIndex`, called
by the standard-object creation handler and this workspace upgrade. They are not
unique constraints or API-visible field indexes. Table deletion drops them through
PostgreSQL's normal dependencies; ordinary metadata index changes leave them alone.
No field/index metadata cache refresh is needed for this physical-only addition.

Run the command with `--dry-run --workspace-id <workspace-id>` first, then without
`--dry-run`. It uses one transaction per workspace and a five-second lock timeout.
A failed workspace rolls back both index builds; rerunning a completed workspace
is a no-op. Missing unprovisioned objects are skipped. An existing reserved index
name with an incompatible definition or invalid index fails closed for operator
repair. Index builds are not concurrent and can briefly block writes while they
hold their table locks. Check canary duration and retry a lock-timeout failure in
a quieter window; do not remove the timeout to force a contended workspace through.

Apply this command before enabling shared-address timeline traffic on upgraded
workspaces. New standard participant tables receive the indexes at creation.
Verify `pg_index.indisvalid = true`, `indisunique = false`, and the normalized-handle
expression. With selective addresses, `EXPLAIN (ANALYZE, BUFFERS)` should show indexed
participant access (typically `BitmapOr`); PostgreSQL may still choose scans for
nonselective requests.

```sh
node dist/command/command.js upgrade:2-32:add-participant-handle-indexes --workspace-id <workspace-id> --dry-run
node dist/command/command.js upgrade:2-32:add-participant-handle-indexes --workspace-id <workspace-id>
```

Include `participant-handle-indexes.command.spec.ts` in the PostgreSQL test run above
for fresh-object provisioning, dry-run/rerun/rollback, duplicate normalized handles,
and selective lookup plan assertions.
