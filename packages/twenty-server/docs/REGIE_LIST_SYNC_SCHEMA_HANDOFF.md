# Regie Lists and Sync Source standard schema handoff

## Objective

Move ownership of the workspace metadata required by Regie Lists and CRM Sync
Sources from Go into Twenty's compiled standard application. After the complete
change is deployed:

- every new workspace is created with the complete Regie schema before it
  becomes active;
- every existing workspace is upgraded through Twenty's durable workspace
  upgrade system;
- existing metadata IDs, physical tables, indexes, relations, and customer
  records are preserved during adoption;
- Go continues to read and write product records, but a later Go PR removes its
  metadata creation and reconciliation code.

The source descriptors for this initial transfer are the versions currently on
`REGIE-io/go` `origin/develop`:

- `regie-lists.v2`: `regieStaticList` and `regieListMembership`;
- `regie-sync-sources.v1`: `regieSyncSource`.

Do not use an older local Go checkout as the schema source. Lists v2 includes
task targets and deliberately has only the `membershipKey` explicit index;
Twenty creates relation indexes as relation side effects.

## PR sequence and ownership

### Twenty PR #122: upgrade runner and operating contract

Branch: `codex/schema-upgrade-runner`

This prerequisite PR provides:

- a PostgreSQL advisory lock around the complete `upgrade` sequence;
- `upgrade:status --fail-on-unhealthy` for an exit-code deployment gate;
- the general workspace-schema implementation and ECS deployment guides.

It does not add the Regie objects. This branch is stacked on its head and should
be rebased or retargeted to `develop` after #122 lands.

### This Twenty PR: schema ownership and adoption

Branch: `codex/regie-list-sync-standard-schema`

This PR must deliver both halves in one Twenty release:

1. the compiled standard-application definitions used by fresh workspaces;
2. a registered workspace adoption command for existing workspaces.

The first WIP commit, `9f6a14ace5`, contains only the initial fresh-workspace
metadata graph. It is not complete or deployment-ready.

### Go PR #1988: rollout contract

`REGIE-io/go#1988` documents the compatibility order, singleton migration
authority, exact-head E2E requirements, and telemetry gate. It does not install
schema and it does not remove the current Go writer.

### Later Go code PR: remove metadata writes

Create this only after the Twenty release has installed the schema for new
workspaces and the adoption command has converged every supported existing
workspace. That later Go PR should:

- remove Lists and Sync Source object, field, relation, and index creation;
- remove startup or control-plane schema reconciliation;
- retain read-only schema readiness checks for one release window;
- keep record-data backfills and normal product record reads/writes in Go;
- remove legacy ensure endpoints and migrations only after telemetry remains
  clean.

## Current WIP contents

The branch currently:

- bumps the Twenty standard application version from `1.0.1` to `1.1.0`;
- defines stable object and field universal identifiers;
- adds standard object metadata for `regieStaticList`,
  `regieListMembership`, and `regieSyncSource`;
- adds scalar and select fields matching the current Go descriptors;
- adds relation pairs for lists and sync sources on `person`, `company`, and
  `task`;
- adds the explicit unique and compound indexes from the Go descriptors;
- registers the new objects in field, object, index, and search metadata maps.

The initial typecheck was interrupted while `twenty-server:typecheck` was still
running. It had emitted no code diagnostic at that point. The local machine has
Node `25.9.0`, while this repository requires Node `^24.5.0`; use a conforming
Node version on the continuation machine.

## Work required to finish this PR

### 1. Validate and complete the fresh-workspace graph

Run the server typecheck first and repair every omitted metadata registration or
type mismatch. Review the standard metadata produced for the three objects and
confirm:

- names, labels, field types, select option values, nullability, and relation
  cardinality match the Go descriptors;
- relation inverse fields exist on `person`, `company`, and `task`;
- `MANY_TO_ONE` relations use `CASCADE` and the expected join-column names;
- the explicit indexes are exactly:
  - unique `regieListMembership.membershipKey`;
  - unique `regieSyncSource.sourceKey`;
  - non-unique `(externalRecordId, externalObjectApiName)`;
- automatically generated relation indexes are not duplicated explicitly;
- stable universal identifiers and select-option IDs are deterministic under
  the Twenty standard application identifier;
- the three objects remain usable through REST for record operations while
  their schema is application-owned and not user-editable.

Add focused standard-metadata tests that compute
`computeTwentyStandardApplicationAllFlatEntityMaps` and assert the complete
object, field, relation, inverse-relation, option, and index shape for a fresh
workspace.

### 2. Implement the existing-workspace adoption command

Add a registered command in the current version directory under:

```text
packages/twenty-server/src/database/commands/upgrade-version-command/2-32/
```

Register it in `2-32-upgrade-version-command.module.ts` after the existing
commands, with a timestamp greater than the current last command.

The command must support three states:

1. **No Regie objects exist:** create the target standard objects, fields,
   relations, inverse fields, and indexes using the current standard metadata
   graph and `validateBuildAndRunWorkspaceMigration`.
2. **All three compatible Go-owned objects exist:** adopt them into the Twenty
   standard application without recreating physical schema.
3. **Partial, duplicate, or incompatible schema exists:** fail the workspace
   closed with an error that names the conflicting object, field, relation, or
   index.

For adoption:

- locate legacy objects by durable names and validate their plural names and
  expected shape;
- validate every scalar field type and every select option value;
- validate both sides of every relation, its cardinality, target, and
  `onDelete` behavior;
- validate explicit indexes by ordered field IDs and uniqueness;
- preserve every existing object, field, relation, index, and physical table ID;
- update universal identifiers and application ownership to the standard
  application;
- re-own the inverse relation fields currently attached to `person`, `company`,
  and `task`;
- use the workspace migration engine rather than direct SQL metadata mutation;
- be a safe no-op when the workspace is already current;
- honor `--dry-run` without writing;
- never delete and recreate an existing customer object or record table.

If the migration engine cannot safely change application ownership and
universal identifiers in one operation, split the adoption into ordered,
resumable commands. Do not bypass validation with direct database writes.

### 3. Test adoption and convergence

Required focused tests:

- fresh workspace receives the complete schema;
- empty existing workspace receives the same schema through the command;
- compatible Go-created schema is adopted while all metadata and physical IDs
  remain unchanged;
- existing records remain readable after adoption;
- rerunning the command is a no-op;
- interrupted execution resumes through the upgrade cursor;
- a missing object in an otherwise partial legacy schema fails closed;
- wrong field type, select options, relation target/cardinality/delete action,
  duplicate name, or index definition fails closed;
- the fresh and adopted paths converge on the same universal identifiers and
  physical constraints.

Use a production-like database snapshot for the final cross-version tests. Unit
fixtures alone cannot prove preservation of physical tables and records.

### 4. Run repository validation

Use Node `^24.5.0`, install dependencies, and keep every command alive until it
exits:

```bash
yarn install --immutable
npx nx typecheck twenty-server
npx nx lint:diff-with-main twenty-server
git diff --check
```

Run the focused standard-metadata and adoption-command Jest suites directly,
then run the relevant Twenty server unit/integration checks. Record exact suite
and test counts in the PR body.

Before requesting review, confirm the branch contains no generated or unrelated
workspace changes and rebase it onto the merged #122 commit.

## Deployment acceptance test

Follow `REGIE_WORKSPACE_SCHEMA_CHANGE_GUIDE.md` and
`REGIE_ECS_UPGRADE_RUNBOOK.md`. In development:

1. build one immutable Twenty image containing this schema and command;
2. confirm server and worker task definitions keep
   `DISABLE_DB_MIGRATIONS=true`;
3. test the old/new overlap order against a production-like snapshot;
4. start exactly one non-load-balanced upgrade task from that image digest;
5. require `upgrade` to exit zero;
6. require `upgrade:status --failed-only --fail-on-unhealthy` to exit zero;
7. restart both server and worker on the same digest to rebuild process-local
   metadata;
8. create a fresh workspace through the real Go provisioning path and verify
   all three objects without Go needing to create them;
9. verify an adopted workspace retained its records and metadata IDs;
10. run Lists and Sync Source read/write canaries through Go;
11. observe Sentry and CloudWatch for at least ten minutes for new metadata,
    duplicate-index, cache, upgrade, or provisioning errors.

Do not remove the Go schema writer during this deployment. Keep it compatible
and idempotent until the fleet and fresh-workspace canaries prove Twenty owns the
complete schema. The later Go cleanup PR is the final ownership cutover.
