# Allow duplicate CRM identities

`person.emails` and `company.domainName` are non-unique. Their existing standard
indexes remain as lookup indexes, including their historical names and universal
identifiers. Twenty's create-many upsert conflict discovery now uses the record ID
instead of the email/domain. Other unique constraints are unchanged.

The versioned command `upgrade:2-20:allow-duplicate-crm-identities` reconciles both
metadata flags and the physical indexes in one transaction per provisioned workspace.
It rebuilds missing/invalid indexes, supports reruns, and refreshes metadata caches
and the workspace metadata version after commit. A 5-second lock timeout rolls back
the current workspace if another workload holds the table. The raw metadata update
is intentional: the generic field uniqueness side effect deletes the backing index;
this upgrade preserves that index's identity and columns as a non-unique lookup.

From the built twenty-server container:

```sh
node dist/command/command.js upgrade:2-20:allow-duplicate-crm-identities --workspace-id <workspace-id> --dry-run
node dist/command/command.js upgrade:2-20:allow-duplicate-crm-identities --workspace-id <workspace-id>
```

First validate in an isolated workspace. Coordinate a pause of Go inbound workers,
deploy Twenty server/worker and apply across provisioned workspaces, deploy Go's
provider-ID-only import behavior, then resume. Omitting `--workspace-id` selects the
provisioned workspace fleet. Explicitly invoke this command for an instance already
at 2.20 if its normal upgrade runner does not revisit that version.

Verify field and index metadata are non-unique, and inspect `pg_index` for valid,
non-unique physical indexes on `person.emailsPrimaryEmail` and
`company.domainNamePrimaryLinkUrl`. Verify two distinct IDs with the same values
persist and an ID replay updates only its row. Regie manual/CSV checks remain at the
application layer; native Twenty API/UI creation permits duplicates.

After duplicates exist, restore neither the old unique indexes nor Go's old fallback
matching automatically. Pause inbound workers and fix forward. Reinstating uniqueness
requires separate data reconciliation; the migration never deletes or merges rows.

## Tests

Run the focused Jest suite normally for the new-workspace metadata/upsert contract.
For PostgreSQL migration, dry-run, rerun, and rollback checks, set
`CRM_DUPLICATES_TEST_DATABASE_URL` to a **disposable database**. The test creates its
own random workspace schema and two minimal metadata tables; do not use a customer DB.

```sh
CRM_DUPLICATES_TEST_DATABASE_URL=<disposable-postgres-url> yarn jest --config packages/twenty-server/jest.config.mjs --runInBand --runTestsByPath packages/twenty-server/src/database/commands/upgrade-version-command/2-20/__tests__/allow-duplicate-crm-identities.command.spec.ts
```
