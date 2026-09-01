# Phone-Scoped Record Search Technical Plan

This document is the implementation plan for an exact, phone-only Person lookup.
It supersedes the earlier `phoneSearchVector`/stored-generated-column design.
That design was functionally correct but changed the generated expression every
time a custom `PHONES` field participated. Twenty implements such a change by
dropping and recreating the stored column and its GIN index, which rewrites the
Person table and can block ordinary reads and writes. A live metadata operation
must not create an outage-shaped Person migration.

The public API and normalization requirements in
`PHONE_SEARCH_REQUIREMENTS.md` remain unchanged. The storage implementation is
replaced by a stable relational lookup projection maintained transactionally.

## Required outcome

Add a dedicated lookup table with one row per distinct canonical phone value,
record, and source field:

```text
personPhoneLookup
  workspaceId
  objectMetadataId
  fieldMetadataId
  recordId
  canonicalPhone
```

The API searches this table by exact canonical phone and the caller's readable,
active `PHONES` field IDs, then applies Person record permissions in the same SQL
query. A PostgreSQL trigger maintains lookup rows in the same transaction as
Person writes. Existing values are populated by resumable BullMQ jobs.

The design must satisfy all of these constraints:

- no generated phone vector and no phone-specific column on Person;
- no Person-table rewrite when phone-field participation changes;
- no `LIKE`, `ILIKE`, generic-search fallback, or post-pagination filtering;
- exact E.164-equivalent lookup through a B-tree index;
- direct SQL, bulk import, and application writes remain transactionally
  consistent because maintenance happens in PostgreSQL;
- ordinary Person reads and writes continue during backfill;
- conflicting Person field-metadata operations may be rejected temporarily;
- queue retries, duplicate deliveries, crashes, and restarts are safe;
- an empty API result is not reported as definitive while any readable active
  phone field is incompletely indexed.

## Why a lookup table

Phone lookup is exact equality, not full-text search. A relational projection
stores provenance directly as `fieldMetadataId`, which makes field permissions
explicit and avoids encoding field IDs into text-search lexemes.

The table and its indexes are stable. Adding or toggling a field changes a small
configuration row and, when necessary, lookup rows for that field. It never
changes the Person table's generated expression or rebuilds a shared index.

The existing generic `searchVector`, its CJK fallback, and all
`SearchFieldMetadata` behavior remain untouched.

## Availability contract

During initial population or repair:

- Person `SELECT`, `INSERT`, `UPDATE`, and `DELETE` remain available;
- updates to phone fields synchronously update the lookup projection;
- non-phone record updates pay only the trigger's change-detection cost;
- when a ready generation exists, phone lookup continues using it while a
  replacement generation is populated and verified;
- only initial enablement, where no complete readable projection exists,
  returns `PHONE_SEARCH_INDEXING`; a newly added field remains outside the
  current projection until its generation cuts over;
- field-metadata mutations affecting the standard Person object are rejected
  with a typed retryable error while the object has an active indexing
  operation;
- metadata operations for other objects and non-schema metadata such as views
  or layouts continue normally.

Backfill consumes database resources and can increase latency, but it must use
bounded transactions, configurable pauses, statement/lock timeouts, and a
single worker per workspace Person object. It must be safe to pause and resume.

## Persistence model

Create three core entities under a new module, tentatively
`engine/core-modules/phone-search-index/`.

### `PersonPhoneLookupEntity`

Table: `core.personPhoneLookup`.

Create it as a fixed-count PostgreSQL hash-partitioned table on `workspaceId`
(start with 32 partitions, configurable only at instance migration time). Every
phone lookup and cleanup predicate contains `workspaceId`, so partition pruning
keeps one large tenant from turning the global lookup table and its indexes into
a single hot structure. The parent table remains the TypeORM entity target;
the instance migration owns creation of the partitions and their indexes.

Columns:

- `id uuid not null`;
- `workspaceId uuid not null`;
- `objectMetadataId uuid not null`;
- `fieldMetadataId uuid not null`;
- `recordId uuid not null`;
- `projectionGeneration bigint not null`;
- `canonicalPhone varchar(32) not null`;
- `createdAt timestamptz not null`;
- `updatedAt timestamptz not null`.

Indexes and constraints:

- primary key `(workspaceId, id)`; PostgreSQL requires every unique constraint
  on this hash-partitioned table to include its partition key;
- unique `(workspaceId, objectMetadataId, fieldMetadataId,
projectionGeneration, recordId, canonicalPhone)` so retries and duplicate
  primary/additional values are idempotent within a generation;
- lookup B-tree `(workspaceId, objectMetadataId, canonicalPhone,
fieldMetadataId, projectionGeneration, recordId)` for the API's equality
  predicate;
- cleanup index `(workspaceId, objectMetadataId, recordId,
projectionGeneration)` for trigger refresh and record deletion;
- cleanup index `(workspaceId, objectMetadataId, fieldMetadataId,
projectionGeneration)` for field removal and retiring old generations.

Create these indexes before enabling writes to a newly installed lookup table,
then let backfill maintain them incrementally. There is no second index-build
cutover after backfill. If an index must later be added to a populated
installation, the instance upgrade must use PostgreSQL's online index-build
path per partition and be resumable; it must not use a transaction-wrapped
blocking `CREATE INDEX` against the populated parent.

Do not add a foreign key from lookup rows to workspace record tables: those
tables are dynamically schema-scoped. Avoid a synchronous cascading foreign key
to `FieldMetadata`; deleting a field could otherwise delete millions of rows in
the metadata request. Workspace and field cleanup are explicit operations.

### `PhoneSearchFieldStateEntity`

Table: `core.phoneSearchFieldState`. One row exists for every standard or custom
Person `PHONES` field known to the projection.

Columns:

- `workspaceId`, `objectMetadataId`, `fieldMetadataId`;
- `fieldUniversalIdentifier` so a field can be identified across metadata-map
  rebuilds;
- `physicalFieldName`, used to derive the three PHONES composite column names;
- `syncStatus`: `INDEXING | READY | FAILED | DELETING`;
- `isQueryEnabled`: mirrors whether the field is active and permitted to
  participate; this is separate from synchronization readiness;
- `configurationGeneration bigint`, incremented whenever field configuration
  changes;
- `activeProjectionGeneration bigint null`, the only complete generation the
  query path may use;
- `buildingProjectionGeneration bigint null`, populated alongside the active
  generation during initialization or repair;
- `lastError`, `lastErrorAt`, `createdAt`, `updatedAt`.

Unique key: `(workspaceId, objectMetadataId, fieldMetadataId)`.

Add a covering lookup index beginning with `(workspaceId, objectMetadataId)`
and including `syncStatus` and `isQueryEnabled`; the Person trigger consults
this table on every write and must not scan field-state rows.

Inactive fields remain transactionally synchronized after their first complete
population, but `isQueryEnabled` is false. This makes later reactivation an
instant metadata transition rather than another table scan. The inactive values
are storage-internal and are never queried unless the field is both active,
readable, and `READY`.

At most two projection generations exist for a field during normal operation.
The trigger maintains both `activeProjectionGeneration` and
`buildingProjectionGeneration` when they differ. Backfill writes only the
building generation. After verification, one short transaction changes the
active pointer to the building generation, clears the building pointer, and
marks the field `READY`; queries therefore see either the entire old generation
or the entire new generation. Retire the old rows asynchronously afterward.

### `PhoneSearchIndexOperationEntity`

Table: `core.phoneSearchIndexOperation`. This is the durable source of truth for
queue work and the Person metadata gate.

Columns:

- `id uuid primary key`;
- `workspaceId`, `objectMetadataId`;
- `kind`: `INITIALIZE | BACKFILL | PURGE_FIELD | REPAIR | DROP_WORKSPACE`;
- `status`: `PENDING | RUNNING | RETRYABLE | FAILED | COMPLETED | CANCELLED`;
- `generation bigint`;
- `fieldMetadataIds jsonb`, containing the immutable field set for this
  operation;
- `lastRecordId uuid null`, the committed keyset cursor;
- `processedRecordCount bigint`, `estimatedRecordCount bigint null`;
- `attemptCount`, `lastError`, `lastErrorAt`; `attemptCount` is the consecutive
  failed-batch count and resets after any successful batch;
- `leaseOwner`, `leaseExpiresAt`, `heartbeatAt`;
- `createdAt`, `startedAt`, `completedAt`, `updatedAt`.

Add a partial unique index allowing at most one active operation per
`(workspaceId, objectMetadataId)` where status is `PENDING`, `RUNNING`, or
`RETRYABLE`. This database constraint, not Redis job identity, is the final
concurrency guard.

Do not treat BullMQ as the source of truth. Redis can be flushed and BullMQ can
deliver a job twice. Database state, generation checks, and leases provide
correctness.

## PostgreSQL extraction and trigger plumbing

### Canonical extraction helper

Install a SQL helper in the fast instance upgrade, for example:

```sql
public.phone_search_values(
  row_value jsonb,
  physical_field_name text
) returns table(canonical_phone text)
```

It reads these dynamic keys from `row_value`:

- `<name>PrimaryPhoneCallingCode`;
- `<name>PrimaryPhoneNumber`;
- `<name>AdditionalPhones`.

It emits calling-code digits plus national-number digits only when both parts
are complete and canonical. It iterates additional phones, rejects malformed
entries, and returns distinct values. The SQL helper and the API input parser
must share fixtures proving equivalent normalization.

### Stable Person trigger

Install one stable row-level trigger on each workspace's physical Person table,
not one generated expression or index per field. Tentative names:

```text
public.sync_person_phone_lookup()
TRG_PERSON_PHONE_LOOKUP_SYNC
```

The trigger receives `workspaceId` and `objectMetadataId` as `TG_ARGV`. It uses
`to_jsonb(NEW)` and `to_jsonb(OLD)` so custom physical field names can be read
from `PhoneSearchFieldStateEntity` without recompiling a function for every
field.

Behavior:

- `INSERT`: refresh lookup rows for every active and building projection
  generation of every configured field;
- `UPDATE`: compare the primary calling-code, primary number, and additional
  phone JSON keys for each configured field; refresh only changed fields;
- `DELETE`: delete every lookup row for the Person record;
- refresh means delete the record/field/generation's old lookup rows and insert
  the distinct current values for every maintained generation in the same
  transaction;
- fields remain maintained while inactive, provided `syncStatus = READY`;
- `DELETING` fields are ignored by extraction after being made query-ineligible.

The trigger is the consistency boundary. Do not implement application-only
dual writes: they miss direct SQL, imports, and future write paths.

Treat the trigger function as privileged database code. Fully qualify every
core relation and helper reference, pin a safe `search_path`, validate and cast
`TG_ARGV` values, and never interpolate a metadata-provided identifier into
SQL. If `SECURITY DEFINER` is required for workspace-table roles to write the
core lookup table, give the function owner only the required lookup-table
permissions and revoke public execution; otherwise prefer the invoker's
permissions. Add an integration test using the same database role as normal
workspace record writes.

Creating the trigger takes a short table lock but does not rewrite Person. Set a
short `lock_timeout`; on rollout, a failure to acquire the lock leaves the
operation pending for retry. For a newly created workspace, install the trigger
before user data exists.

The implementation must benchmark the trigger's overhead for:

- an update to an unrelated Person field;
- one primary phone update;
- replacement of multiple additional phones;
- bulk Person insert/update.

If generic `to_jsonb(NEW)` change detection is too expensive, optimize only
after measuring. A per-field trigger is an allowed fallback, but it must retain
the same state model and short-lock behavior.

## Query path

Retain the dedicated GraphQL operation in the existing search module:

- `dtos/search-people-by-phone.args.ts`;
- `dtos/phone-search-result.dto.ts`;
- `services/phone-search.service.ts`;
- `search.resolver.ts` and `search.module.ts`.

The first-version resolver accepts only `phoneNumber` (strict E.164), required
`limit` in `[1,100]`, and optional opaque `after`. It has no country, object, or
field selector. TypeScript parses untrusted E.164 input with libphonenumber;
`phone_search_values` only projects stored `+callingCode` plus national digits.
Both roles share an executable fixture corpus for their canonical key contract.
The response exposes only deduplicated Person `recordId` edges and cursors;
matching field/value provenance and national-format input are future versioned
additions.

Remove all `phoneSearchVector` and `to_tsquery` construction. After normalizing
the request, resolve Person permissions exactly as the existing service does.
Build the set of field IDs that are all of:

- metadata type `PHONES`;
- active;
- readable by the effective role;
- represented by a field-state row with `isQueryEnabled = true` and a non-null
  `activeProjectionGeneration` that was previously verified.

Pair each readable, query-enabled field ID with its non-null
`activeProjectionGeneration`. An `INDEXING` field may still be queried when
that pointer names a previously verified generation. A newly added field with
only a building generation is not part of the current projection until atomic
cutover. Return a typed retryable readiness error when no complete readable
projection exists, or when projection state is missing/corrupt. This preserves
the definitive semantics of the currently active projection without
interrupting searches during replacement work.

Use one Person repository query with an indexed correlated `EXISTS` predicate:

```sql
WHERE EXISTS (
  SELECT 1
  FROM core."personPhoneLookup" lookup
  WHERE lookup."workspaceId" = :workspaceId
    AND lookup."objectMetadataId" = :personObjectMetadataId
    AND lookup."recordId" = person.id
    AND lookup."canonicalPhone" = :canonicalPhone
    AND (lookup."fieldMetadataId", lookup."projectionGeneration") IN
        (:readableFieldGenerationPairs)
)
```

Apply deleted-record, row-level permission, cursor, and ordering predicates
before `limit + 1`. `EXISTS` deduplicates a Person matching multiple fields
without `DISTINCT` or post-filtering. Never select lookup values or field IDs in
the response.

Add `EXPLAIN` integration tests with sequential scans disabled proving that hit
and miss queries use the lookup B-tree. Keep tests that assert no `LIKE`,
`ILIKE`, generic fallback, `phoneSearchVector`, or `to_tsquery` appears.

## Metadata lifecycle

Phone search state must be driven from field metadata, but it must not use
`SearchFieldMetadata` or TS-vector rebuild side effects.

### New active custom `PHONES` field

The normal field migration creates empty nullable physical columns. In the same
metadata transaction:

1. obtain the short object-scoped metadata guard;
2. create a `PhoneSearchFieldState` row as `READY` and query-enabled with
   `activeProjectionGeneration = 1`;
3. commit the field and state together.

No backfill is needed because a new field has no historical values. The stable
trigger discovers the configuration row and indexes subsequent writes.

### New inactive custom `PHONES` field

Create its state as `READY`, query-disabled with
`activeProjectionGeneration = 1`. Continue maintaining it when values are
written through administrative paths so activation can be immediate.

### Rename

Update `physicalFieldName` in the same transaction as the physical column
rename. Lookup rows are keyed by immutable field ID and remain valid. No purge,
backfill, or lookup-index change is required.

### Deactivate and reactivate

Deactivation sets `isQueryEnabled = false` atomically with field deactivation.
The trigger continues maintaining stored values. Reactivation sets it true only
when an active projection generation exists; otherwise it schedules/resumes a
backfill and the lookup API returns readiness until the first generation is
complete.

### Delete

Before physical source columns are dropped:

1. mark the state `DELETING` and query-disabled;
2. create a `PURGE_FIELD` operation;
3. allow the normal field deletion once the trigger will no longer reference
   that field's keys;
4. asynchronously delete lookup rows in bounded batches;
5. delete the field-state tombstone after purge completion.

The field-metadata ID is deliberately retained in the operation row without a
cascading FK, so cleanup remains possible after metadata deletion.

### Non-`PHONES` fields and other objects

Do nothing. Company phone fields do not participate in the first API. Recreating
a deleted logical name as `TEXT` creates no phone state. Recreating it as
`PHONES` receives a new field ID and a new independent state row.

## Metadata operation gate

The gate prevents a sequence of Person schema changes from racing an incomplete
backfill or purge. It does not block record CRUD.

Implement `PhoneSearchMetadataGateService` and invoke it at two levels:

1. `FieldMetadataService` create/update/delete paths, to return a clear API
   error before expensive migration planning;
2. `WorkspaceMigrationValidateBuildAndRunService`, to cover REST, GraphQL,
   tools, application manifests, and any caller bypassing `FieldMetadataService`.

The second check is authoritative. It examines the final operation set and
applies when a field mutation or Person object deletion targets the standard
Person object. Internal phone-index operations carry an explicit operation ID
and generation allowing only that worker to bypass its own gate.

Gate acquisition uses a transaction-scoped PostgreSQL advisory lock derived
from `(workspaceId, personObjectMetadataId)` only while checking/creating the
operation row. Never hold an advisory lock for the duration of a BullMQ job.
The partial unique active-operation constraint handles cross-process races.

When blocked, return a typed retryable error containing:

- operation ID and status;
- operation kind;
- processed and estimated counts when known;
- `retryAfter` guidance;
- the last error when the caller is an authorized administrator.

Only Person field/object schema mutations are gated. Person record CRUD, other
objects' field mutations, views, layouts, roles, and other metadata remain
available.

## Sequences of metadata changes

Do not queue and replay arbitrary admin mutation payloads. A rename or delete
request can become stale while waiting, and replaying it later is unsafe.
Conflicting requests are rejected and must be resubmitted against current
metadata after the active operation completes.

Required cases:

### Two admins race

Both requests take the short advisory lock. The first request that creates an
active operation/generation wins. The second sees the active database row and
receives `PHONE_SEARCH_METADATA_BUSY`. Redis ordering is irrelevant.

### Several changes in one API request

`createManyFields` or an application manifest is validated as one final desired
state. If it requires asynchronous work, create one object operation containing
the union of affected field IDs. Apply no partial metadata changes before the
operation and gate are durably recorded.

### A second request arrives during backfill

Reject it without changing metadata. Return current operation progress. The
caller may retry after completion. Do not append it to a Redis queue.

### Rename followed by deactivate

When no long operation exists, each is a short synchronous state transition and
may complete normally in order. If either encounters an active initialization,
repair, or purge, reject it. After retry, resolve the field again by immutable
ID rather than stale physical name.

### Deactivate followed by reactivate

Once a field has reached `READY`, both are synchronous toggles because inactive
values remain maintained. During initial indexing, reject both until indexing
completes; do not expose a partially indexed field.

### Delete followed by recreation of the same logical name

Hold the Person metadata gate until the old field's purge operation completes.
The recreation then receives a new field ID. This prevents old lookup rows from
being confused with the new field even if names are reused.

### Worker fails permanently

After five consecutive failed batches, set the operation and affected building
field states to `FAILED`, clear only the building generation, and enqueue a
bounded purge of that inactive generation. Preserve any active generation so
phone search and CRM record CRUD remain available. The terminal failed
operation does not keep the metadata gate closed; a pending cleanup operation
may hold it only while cleanup is active. Failure bookkeeping is committed in a
separate transaction after the failed batch rolls back so the reconciler cannot
retry forever without advancing the counter.

### Process crashes after database commit but before enqueue

The operation remains `PENDING`. A periodic reconciler scans `PENDING`,
`RETRYABLE`, and expired-lease `RUNNING` rows and enqueues work again. Duplicate
jobs are harmless because the database lease and generation are checked before
each batch.

## BullMQ execution model

Add `MessageQueue.phoneSearchIndexQueue` and a complete entry in
`message-queue-worker-config.constant.ts`. Start with concurrency `1` per worker
and enforce one active operation per workspace Person object in PostgreSQL.

Create a module under `engine/core-modules/phone-search-index/` containing:

- `jobs/phone-search-index.job.ts` with `@Processor` and `@Process`;
- `services/phone-search-index-orchestrator.service.ts` for operation creation,
  enqueue, retry, cancellation, and status;
- `services/phone-search-index-backfill.service.ts` for one bounded batch;
- `services/phone-search-trigger-manager.service.ts` for trigger installation
  and verification;
- `services/phone-search-metadata-gate.service.ts`;
- `crons/phone-search-index-reconciler.cron.job.ts` or the repository's
  equivalent recurring-job registration for orphaned operations;
- DTOs/types for job data and statuses;
- TypeORM entity registration and module exports needed by Search and Metadata.

Job data contains only `operationId`. Never put cursors or desired field sets
solely in Redis.

For each delivery:

1. lock the operation row `FOR UPDATE`;
2. no-op if completed/cancelled, wrong generation, or another unexpired lease
   owns it;
3. claim/renew a bounded lease and commit;
4. execute one batch;
5. transactionally update the cursor/count/status;
6. enqueue the next delivery after commit when work remains;
7. after final verification, atomically point each field's
   `activeProjectionGeneration` at its building generation, clear the building
   pointer, mark states `READY`, and mark the operation `COMPLETED`;
8. release the metadata gate by completing the active operation row.

Use retries with exponential delay for lock timeouts, connection failures, and
temporary load shedding. Validation/corruption errors become `FAILED` and
require explicit repair.

### Correct backfill transaction

Install and enable the trigger before recording the operation as runnable. For
each batch, select Person records in deterministic UUID order:

```sql
SELECT ...
FROM workspace_x.person
WHERE id > :lastRecordId
ORDER BY id
LIMIT :batchSize
FOR UPDATE
```

Do not use `SKIP LOCKED` with a permanently advanced keyset cursor; that can
skip a locked record forever. Keep transactions small. The selected row locks
briefly serialize a concurrent update to those specific records. Refresh lookup
rows for the operation's field set, commit, and only then persist/advance the
cursor.

The trigger covers inserts and changes after earlier batches commit and writes
both the old active and new building generation during a replacement. Retrying
a batch is safe because refresh is delete-plus-idempotent-insert. A final
verification compares eligible source counts/sample hashes and checks that no
operation field remains non-ready before the pointer cutover. Existing queries
continue using the old active generation throughout; old-generation rows are
purged asynchronously only after the new pointer commits.

Each batch sets a two-second `lock_timeout` and the configurable
`PHONE_SEARCH_INDEX_BATCH_STATEMENT_TIMEOUT_MS` (30 seconds by default). The
retry ceiling is five consecutive failures. Emit progress metrics and
structured logs tagged by workspace, operation, generation, cursor, and
duration.

## Fresh workspace and upgrade paths

### Fast instance upgrade

Replace the current phone-vector instance command with a command that:

- creates the three core tables, enums/check constraints, and indexes;
- installs `public.phone_search_values` and
  `public.sync_person_phone_lookup`;
- has a reversible `down()` for instance-owned objects, with an explicit guard
  refusing to drop non-empty lookup tables accidentally.

Register it through `instance-commands.constant.ts`.

### Fresh workspace

After standard Person physical metadata is created:

1. create the standard phone-field state and durable build operation through
   the normal metadata lifecycle hook;
2. install the stable trigger on the empty Person table before workspace
   initialization returns;
3. let the normal worker complete the empty build and atomically mark the
   projection `READY`.

Hook this into workspace creation after Person DDL exists, not into standard
`FieldMetadata` as a fake `TS_VECTOR` field.

### Existing workspace

The versioned workspace command must be quick:

1. resolve the standard Person object, schema, and every standard/custom
   `PHONES` field;
2. acquire the short gate;
3. install/verify the stable trigger with a lock timeout;
4. create `INDEXING` field-state rows with no active generation and a new
   building generation for active and inactive phone fields;
5. create one `INITIALIZE` operation containing all fields;
6. enqueue after commit and return without scanning Person.

The operation marks each state `READY` after all current values are populated;
only active fields become query-enabled. Rerunning the workspace command must
find the existing state/operation and do nothing or re-enqueue a resumable
operation. It must never create duplicate lookup rows.

The workspace command has no `down()` in Twenty's current workspace-command
contract. Document operational rollback: set every phone field state
query-disabled, stop/reconcile jobs, drop workspace triggers, then remove core
objects only through the instance rollback after lookup data is empty.

### Workspace deletion

Workspace deletion drops the tenant schema first, then directly deletes lookup
rows in bounded batches and deletes field-state and operation rows before the
core workspace row is removed. The three core tables are owned derived
infrastructure, not metadata. Each has a workspace foreign key with `ON DELETE
CASCADE` as the final hard guarantee if deletion is interrupted or a concurrent
path reaches the core-row delete. The cleanup path is idempotent and tolerates
the physical workspace schema already being absent.

## Concrete code change map

### Remove/supersede current vector implementation

Remove the phone-only changes involving:

- `phoneSearchVector` standard field/index constants and Person workspace
  entity property;
- phone-specific `SearchFieldMetadata` rows and target-aware identifiers that
  exist only to support the second vector;
- phone-vector expression builders and SQL token helper;
- generic TS-vector migration-runner changes made solely for multiple vectors;
- field side effects that rebuild `phoneSearchVector`;
- the workspace upgrade that provisions/rebuilds the vector.

Do not remove unrelated generic-search fixes. Re-evaluate the target-aware
`SearchFieldMetadata` uniqueness change: if no other feature needs multiple
vectors, revert it to minimize framework surface.

### Add core persistence and SQL

Add the three entities, enums, repositories, SQL helpers, trigger manager, and
instance upgrade under:

- `engine/core-modules/phone-search-index/`;
- `database/commands/upgrade-version-command/<version>/`;
- `database/commands/upgrade-version-command/instance-commands.constant.ts`.

Register the module in `core-engine.module.ts`, queue worker discovery, command
modules needed by upgrades, and TypeORM entity discovery following adjacent
core modules.

### Add queue plumbing

Change:

- `engine/core-modules/message-queue/message-queue.constants.ts`;
- `engine/core-modules/message-queue/message-queue-worker-config.constant.ts`;
- the new phone-index job/module and a reconciler registration.

Use `MessageQueueService.add` with operation ID job data. The database operation
row remains authoritative because the BullMQ driver intentionally does not
provide exactly-once delivery.

### Integrate metadata gating and lifecycle

Change:

- `engine/metadata-modules/field-metadata/services/field-metadata.service.ts`
  for friendly early checks on create/update/delete;
- `workspace-migration/services/workspace-migration-validate-build-and-run-service.ts`
  for the authoritative operation-set check;
- metadata side-effect handlers or an equivalent post-plan hook to create and
  update field-state rows without TS-vector contributions;
- object/workspace deletion handlers for cancellation and cleanup.

All GraphQL, REST, and tool field mutations already funnel through
`FieldMetadataService`; the migration-service check covers other builders and
application synchronization.

### Update the API service

Keep the focused resolver/DTO surface but replace the vector predicate in
`engine/core-modules/search/services/phone-search.service.ts` with the indexed
`EXISTS` query and readiness validation. Keep permission-aware field selection,
normalization, deterministic ID pagination, and generic-search isolation.

## Testing plan

### SQL and trigger integration

Against real PostgreSQL, prove:

- extraction of primary/additional values, malformed inputs, and duplicates;
- direct SQL insert/update/delete changes lookup rows in the same transaction;
- rollback rolls back both Person and lookup changes;
- bulk writes are covered;
- non-phone updates do not rewrite lookup rows;
- inactive-but-ready fields remain synchronized but cannot be queried;
- field rename/config update reads the new physical columns;
- trigger installation retries cleanly on lock timeout.

### Indexed query tests

Use production-sized fixtures and `EXPLAIN` with sequential scans disabled to
prove lookup-index use for hit and miss queries. Test multiple matching fields,
record deduplication, pagination, object/row/field permissions, and readiness
errors. Assert the query never references `LIKE`, `ILIKE`, `to_tsquery`, or a
phone vector.

### Backfill correctness

Test:

- empty, small, multi-batch, and large workspaces;
- primary and additional phones across standard/custom fields;
- update/delete/insert racing the current, earlier, and later batches;
- crash before cursor commit and after cursor commit;
- duplicate BullMQ delivery;
- expired lease recovery;
- Redis flush after database operation creation;
- restart/resume from the last committed cursor;
- final cutover only after complete verification;
- retryable versus terminal errors;
- cancellation never exposes incomplete results.

### Metadata sequencing

Test two concurrent admins and assert only one operation is created. Cover
create-many coalescing, blocked rename/deactivate/delete during backfill,
resubmission after completion, delete/recreate with a reused logical name,
failed-operation retry, and operations on other objects proceeding while Person
is gated.

### Upgrade and cleanup

Test fresh workspace readiness, existing workspace asynchronous initialization,
idempotent command reruns, legacy active/inactive custom fields, malformed legacy
values, workspace deletion during a job, and operator rollback steps.

### Performance gates

Before rollout, record representative benchmarks for 100k, 1m, and 10m Person
rows:

- trigger latency for phone and non-phone writes;
- backfill rows/second, WAL volume, CPU, and replication lag;
- lookup hit/miss latency and index size;
- batch lock duration and observed Person write latency.

Set rollout defaults from those results. The feature must support pausing by
workspace and a global kill switch that disables scheduling while preserving
transactional trigger maintenance.

## Suggested implementation order for Terra

1. Revert the unshipped phone-vector storage changes while retaining the API
   contract and reusable normalization tests.
2. Add core entities, constraints, status types, and the fast instance upgrade.
3. Add SQL extraction/trigger functions and real-PostgreSQL transactional tests.
4. Add trigger installation for fresh/existing workspaces.
5. Implement durable operation creation, leases, one-batch processing, queue
   registration, and the orphan reconciler.
6. Implement the metadata gate at both service and migration boundaries.
7. Implement lifecycle state transitions and sequence handling.
8. Replace the API vector query with the indexed lookup-table `EXISTS` query.
9. Implement the existing-workspace initializer, cleanup, retry, and cancel
   commands.
10. Port and expand acceptance tests, then run performance benchmarks.

Do not declare completion based only on API behavior. Acceptance requires real
PostgreSQL trigger tests, concurrent-write/backfill tests, metadata race tests,
query-plan evidence, fresh and upgraded workspace tests, and proof that ordinary
Person CRUD continues while a multi-batch backfill is running.
