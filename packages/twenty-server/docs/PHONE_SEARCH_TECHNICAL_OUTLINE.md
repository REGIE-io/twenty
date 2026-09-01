# Phone-Scoped Record Search Technical Outline

This document describes the proposed structure, the concrete Twenty integration
points, and implementation sequencing. Exact GraphQL names and rollout timing
remain product/release decisions.

## Proposed shape

Add a second internal generated `TS_VECTOR` field, tentatively named
`phoneSearchVector`, to the `person` object. Back it with a single-column GIN
index. Build the field/index machinery from object metadata so it can be reused
for another object later without making the first public API generic.

The two vectors have separate contracts:

- `searchVector` remains the combined vector used by existing generic search.
- `phoneSearchVector` contains only phone lookup tokens and is queried only by
  the new phone-scoped API.

The existing `SearchService` continues to reference `searchVector` by its current
constant and is not changed to discover or query the new vector.

## Why a separate vector

The existing combined vector does not retain enough provenance to guarantee
that a token matched a phone field. Disabling its `ILIKE` fallback changes cost,
not search semantics. A separate vector gives PostgreSQL an independent inverted
index whose contents are constrained to phone data.

Multiple `tsvector` columns on one PostgreSQL table are supported. Clear system
field names, deterministic universal identifiers, and separate metadata
ownership keep their responsibilities unambiguous.

## Concrete change map

### 1. Allow one source field to feed more than one vector

This is the one metadata-model change required before adding the phone vector.
Although `SearchFieldMetadata` already has `tsVectorFieldMetadataId`, today it is
still unique on `(objectMetadataId, fieldMetadataId)`, and its deterministic
universal identifier is derived only from the source field. The standard
`person.phones` field therefore cannot currently contribute to both
`searchVector` and `phoneSearchVector`.

Change these locations:

- `packages/twenty-server/src/engine/metadata-modules/search-field-metadata/search-field-metadata.entity.ts`
  changes the unique constraint to `(objectMetadataId, fieldMetadataId,
  tsVectorFieldMetadataId)`.
- Add a target-aware deterministic identifier helper beside
  `packages/twenty-shared/src/application/deterministic-identifier/get-search-field-universal-identifier.util.ts`.
  Its identity input is the source field universal identifier plus the target
  vector universal identifier.
- Keep `getSearchFieldUniversalIdentifier` and all existing generic-search row
  identifiers unchanged. Use the new helper only for secondary-vector
  contributions. This avoids rewriting every installed application's current
  search metadata.
- Add a fast instance upgrade in the next version directory under
  `packages/twenty-server/src/database/commands/upgrade-version-command/` to
  replace the old unique constraint. Register it through the generated
  `instance-commands.constant.ts` flow.
- In
  `workspace-migration-builder/validators/services/flat-search-field-metadata-validator.service.ts`,
  change the equivalent-row check from source field alone to source field plus
  target vector.

Update the entity and deterministic-identifier tests. Also add a validator test
showing that the same source field may target two vectors, while a duplicate
source/target pair is still rejected.

### 2. Define the phone-vector field, index, and contribution builders

Add a phone-specific constant next to
`search-vector-field.constants.ts`, with the fixed name
`phoneSearchVector`, labels, and deterministic naming inputs. Do not add it to
`SEARCH_VECTOR_FIELD`; generic search must continue resolving only
`searchVector`.

Leave
`flat-search-field-metadata/utils/find-ts-vector-flat-field-metadata-for-object.util.ts`
scoped to the field named by `SEARCH_VECTOR_FIELD`. Despite its broad filename,
that helper is how generic label/search behavior deliberately finds the original
vector and must not start discovering the phone vector.

Add builders parallel to:

- `build-search-vector-flat-field-metadata-for-custom-object.util.ts` for the
  engine-owned `TS_VECTOR` field;
- `build-search-vector-gin-index-for-custom-object.util.ts` for its GIN index;
  and
- `build-flat-search-field-metadata-for-field.util.ts` for a phone contribution
  using the target-aware identifier.

The builders should be parameterized by the parent object and source field so
the metadata machinery is reusable, but the first API and standard metadata
use them only for `STANDARD_OBJECTS.person`.

### 3. Add `phoneSearchVector` to standard Person metadata

The Twenty standard application is assembled directly; its synchronization path
does not run metadata side-effect handlers. Consequently the standard Person
surface must be declared explicitly in all three places:

- `packages/twenty-shared/src/metadata/constants/standard-object-fields.constant.ts`
  adds the deterministic `phoneSearchVector` field universal identifier, and
  `standard-object.constant.ts` adds `phoneSearchVectorGinIndex`.
- `packages/twenty-server/src/engine/workspace-manager/twenty-standard-application/utils/field-metadata/compute-person-standard-flat-field-metadata.util.ts`
  creates the hidden system `TS_VECTOR` field.
- `packages/twenty-server/src/engine/workspace-manager/twenty-standard-application/utils/index/compute-person-standard-flat-index-metadata.util.ts`
  creates its GIN index.

Do not add the second contribution to
`SEARCH_FIELDS_BY_STANDARD_OBJECT_NAME`: that constant and
`create-standard-search-field-flat-metadata.util.ts` intentionally target the
generic `searchVector`. Instead add a small phone-specific standard search-field
builder and merge its Person rows in
`build-standard-flat-search-field-metadata-maps.util.ts`. Initially it emits the
standard `person.phones` contribution targeting `phoneSearchVector`.

Update `compute-person-standard-metadata.spec.ts`, standard universal-identifier
snapshots, and related-entity-ID snapshots.

### 4. Produce exact, field-qualified phone lexemes

Do not reuse the current generic `PHONES` expression unchanged. In
`get-ts-vector-column-expression.util.ts` it intentionally emits several loose
representations and flattens additional-phone JSON for generic text search. The
phone vector needs one canonical token per phone value and field provenance.

Add a dedicated expression utility under
`engine/metadata-modules/flat-search-field-metadata/utils/`. For each active
`PHONES` field it emits tokens of this shape:

```text
f<field-universal-id-without-hyphens>p<calling-code-and-national-number-digits>
```

The fixed letter separators make the value one `simple`-dictionary lexeme and
avoid a leading numeric token. The API constructs the same token; field names
are not part of it, so renaming a field does not change permission provenance.

Pairing `callingCode` and `number` in the additional-phone JSON is awkward in a
generated-column expression because PostgreSQL disallows subqueries and
set-returning expressions there. Add an immutable database helper, for example
`public.phone_search_tokens(field_key text, primary_calling_code text,
primary_number text, additional_phones jsonb) returns text`. It should:

- emit the primary token only when both canonical components are present;
- iterate additional phones and emit one token per complete pair;
- strip the calling-code `+` and reject/skip non-digit residual data; and
- return a space-delimited string consumed by `to_tsvector('simple', ...)`.

Install that function in the same fast instance upgrade that changes the
constraint, with a `down` implementation. Extend
`assertSafeTsVectorExpression` tests if the new generated expression introduces
syntax not exercised by the existing validator; do not weaken its forbidden
token checks.

`derive-search-vector-as-expression-for-ts-vector-field.util.ts` currently
passes only source field name and type. Extend its indexed-field description to
include field universal identifier, and dispatch by the target vector's stable
identifier/name:

- generic `searchVector` continues through
  `computeSearchVectorAsExpressionFromSearchFieldMetadatas`; and
- `phoneSearchVector` goes through the new phone-only expression builder and
  ignores any non-`PHONES` contribution defensively.

Both callers must pass the target vector to that dispatch:

- `workspace-migration-runner/action-handlers/object/services/create-object-action-handler.service.ts`;
  and
- `workspace-migration-runner/action-handlers/field/services/update-field-action-handler.service.ts`.

The expression and database helper need integration tests covering nulls,
primary values, multiple additional values, multiple custom fields, and values
with the same digits in different fields.

### 5. Maintain custom Person phone fields through metadata side effects

Add field-create and field-update handlers under
`metadata-side-effect/handlers/field-metadata/services/`, then register them in
`metadata-side-effect-handlers.module.ts`.

The create handler should add a phone contribution only when all of these are
true:

- the parent object is standard `person` (compare its universal identifier);
- the new field type is `PHONES`; and
- the field is active.

The update handler compares the existing and optimistic post-change field. It
creates the contribution on inactive-to-active, deletes it on
active-to-inactive, and lets a rename retain the same contribution row while
triggering expression regeneration. Follow the optimistic-parent resolution
pattern used by `field-unique-backing-index-on-update-side-effect-handler.service.ts`
so multiple metadata operations in one request see the same after-state.

Field type is not currently an editable field-metadata property:
`UpdateFieldInput` omits `type`, and
`FLAT_FIELD_METADATA_EDITABLE_PROPERTIES` excludes it. The supported transition
is deactivate, delete, and recreate. If type mutation is enabled later, the same
update handler should treat it as contribution create/delete, but this feature
does not need to add a new field-type migration mechanism.

Deletion does not need a second custom cascade:
`field-search-field-metadata-on-delete-side-effect-handler.service.ts` already
deletes every contribution attached to the field. Object deletion likewise
collects every engine-owned field, index, and search contribution in
`object-system-side-effects-on-delete-side-effect-handler.service.ts`; add tests
that the new entities are included.

Creating/deleting a `SearchFieldMetadata` row already feeds its target vector
into
`compute-search-vector-rebuild-target-universal-identifiers.util.ts`. However,
`aggregate-orchestrator-actions-report-deprioritize-search-vector-update-field-actions.util.ts`
still recognizes rebuild actions by the literal field name `searchVector`.
Change that classification to use `FieldMetadataType.TS_VECTOR` or membership in
the computed target set, otherwise a simultaneous phone-vector metadata update
can create duplicate/out-of-order update actions.

Keep the phone vector present when the last phone field becomes inactive. Its
expression becomes `to_tsvector('simple', NULL)` and the stable empty index
avoids repeated field/index DDL as custom fields are toggled.

### 6. Add the dedicated GraphQL operation

Add the operation inside the existing search module without changing
`SearchService`:

- `dtos/search-people-by-phone.args.ts` validates `phoneNumber`, optional
  `countryCode`, `limit`, and `after`;
- `services/phone-search.service.ts` contains normalization, permission-aware
  query construction, and pagination; and
- either a focused `phone-search.resolver.ts` or a new query method on
  `search.resolver.ts` exposes `searchPeopleByPhone`.

Register the service/resolver in `search.module.ts`. Reuse the existing
`WorkspaceAuthGuard`, `CustomPermissionGuard`, validation pipe, and permission
exception filter. A small phone result connection should contain Person record
IDs and cursors; reuse the generic result DTO only if the client actually needs
its label/image fields. Do not expose rank fields because exact lookup has no
meaningful rank.

The resolver/service flow is:

1. Enter `GlobalWorkspaceOrmManager.executeInWorkspaceContext`, resolve the role
   permission config exactly as `SearchService` does, and obtain the `person`
   `WorkspaceRepository` with that config.
2. Load Person object/field metadata. Read the effective object/field permission
   map already exposed by `WorkspaceRepository.objectRecordsPermissions`; for a
   bypass configuration, treat all active phone fields as readable. This keeps
   the field-token query in lockstep with the same union/intersection role
   calculation used by the repository.
3. Return/throw the normal permission result if Person records are not readable.
4. Select active Person `PHONES` fields whose
   `restrictedFields[field.id].canRead !== false`.
5. Parse input with `libphonenumber-js` using the same validation rules as
   `transform-phones-value.util.ts`, producing calling-code plus national-number
   digits. Extract a shared pure normalization helper rather than calling the
   record transformer with a fabricated field value.
6. Build an OR `tsquery` containing one exact qualified lexeme for every
   readable phone field. If there are no readable phone fields, return an empty
   connection without issuing SQL.
7. Select only permitted response columns from the repository, apply
   deleted-record and cursor predicates, and query:

```sql
"phoneSearchVector" @@ to_tsquery('simple', :qualifiedPhoneQuery)
```

The workspace query builder continues to enforce object and row-level
permissions. Field qualification is additionally required because the hidden
vector contains values from fields that may be restricted. Never select the
vector itself and never post-filter matches after pagination.

Use deterministic `(id)` ordering for the first version. Encode the last ID in
the cursor and request `limit + 1`, matching the connection behavior used by
other core APIs. There is exactly one indexed query and no call to
`buildSearchQueryAndGetRecordsWithFallback`, `LIKE`, or `ILIKE`.

GraphQL schema/client artifacts should be regenerated by the repository's
normal generation commands after the resolver DTOs land.

### 7. Upgrade existing workspaces

Add an idempotent workspace command in the next release directory and register
it in that version's module. Follow the standard-metadata reconciliation pattern
used by
`2-25-workspace-command-1785229970000-add-message-campaign-name-field.command.ts`:

1. Load Person and current field/index/search metadata maps.
2. Compute the current Twenty standard application maps.
3. Copy in any missing standard `phoneSearchVector` field, GIN index, and
   standard-phone contribution.
4. Add target-aware contributions for every active custom Person `PHONES`
   field; derive each from the shared builders rather than hand-assembling rows.
5. Submit the merged maps through
   `WorkspaceMigrationValidateBuildAndRunService` so normal validation,
   ordering, cache invalidation, and schema DDL apply.
6. On rerun, identify every entity by deterministic universal identifier and do
   nothing when the desired state already exists.

The instance upgrade (constraint plus immutable helper) must complete before
this workspace command. The workspace operation should be classified as slow:
the current update-field action handler drops and re-adds a stored generated
column, then recreates its GIN index. On a large Person table that rewrites data
and takes locks. Rollout should use normal slow-upgrade observability and be
benchmarked on a representative large workspace before enabling broadly.

No separate record backfill is needed: adding the stored generated column
computes values for existing rows. A preflight/report should count legacy phone
values missing either calling code or normalized national number; those rows
will intentionally not match until normalized rather than causing permanent
display-format tokens in the index.

### 8. Suggested implementation order

1. Core constraint and immutable SQL helper.
2. Target-aware identity plus phone field/index/contribution builders.
3. Expression dispatch and multi-vector migration-runner fixes.
4. Standard Person metadata and existing-workspace upgrade.
5. Custom-field lifecycle side effects.
6. Dedicated permission-aware GraphQL service/resolver.
7. End-to-end query-plan and regression tests.

## Record updates

Because `phoneSearchVector` is a stored generated column, PostgreSQL recalculates
it and maintains the GIN index when any referenced primary or additional phone
column changes. No application-level record-write hook should be required.

Metadata changes still require rebuilding the generated expression because the
set of referenced physical columns has changed.

## Detailed test model

### Unit contracts

Add focused unit suites beside the implementation utilities:

- The target-aware search-field identifier is stable, differs for two target
  vectors, and leaves the existing generic identifier unchanged.
- Search-field validation accepts one source field targeting `searchVector` and
  `phoneSearchVector`, but rejects a duplicate source/target pair.
- Input normalization maps formatted E.164 and stored calling-code/national
  parts to the same digits and rejects invalid or country-ambiguous input.
- Field-token construction produces one parser-safe lexeme from the immutable
  field universal identifier and canonical digits.
- The phone expression includes only active `PHONES` fields, produces primary
  and additional tokens, escapes physical column names, and yields an empty
  vector for no contributions.
- The existing generic expression output remains byte-for-byte unchanged for
  the same metadata fixture.

Extend
`aggregate-orchestrator-actions-report-deprioritize-search-vector-update-field-actions.util.spec.ts`
with two vectors in one action report. Assert one rebuild action per affected
vector and that source-field DDL precedes the phone-vector rebuild.

### Database expression and index tests

Run the immutable SQL helper against real PostgreSQL values, not only string
snapshots. Cover:

- null/partial primary values;
- a valid primary value;
- empty, null, malformed, and multi-entry additional-phone JSON;
- two additional phones with different calling codes;
- duplicate values, with an explicit decision whether duplicate lexemes are
  harmless or deduplicated; and
- the same number under two field keys, producing two distinct lexemes.

Create a temporary Person-like table with the generated vector and GIN index.
Insert rows, update primary and additional values, and assert that lookup changes
in the same transaction semantics without an application hook. Use `EXPLAIN`
with sequential scans disabled to prove both hit and miss forms can use the GIN
index. Also sample a production-sized fixture because PostgreSQL can reasonably
choose a sequential scan for tiny tables.

### Metadata lifecycle integration test

Add a Person-specific suite alongside the existing tests in
`test/integration/metadata/suites/field-metadata/`. Use the real metadata
GraphQL helpers and the following ordered scenario so it exercises schema DDL,
metadata side effects, and retained records together:

1. Confirm Person initially has `phoneSearchVector`, its GIN index, and one
   phone contribution for the standard `phones` field.
2. Create an active custom `PHONES` field named `alternatePhones`. Assert a
   second targeted contribution exists and the phone-vector expression names
   both composite fields.
3. Write one Person with a custom primary number and two custom additional
   numbers. Assert all three are found by the dedicated API.
4. Deactivate `alternatePhones`. Assert its contribution disappears, its three
   numbers stop matching, the standard phone still matches, and the vector/index
   metadata remain.
5. Reactivate it. Assert the contribution and all existing custom values become
   searchable again after the generated expression rebuild.
6. Rename it to `renamedAlternatePhones`. Assert the contribution keeps the
   same universal identifier/field key, the generated expression switches to
   the renamed physical columns, the GIN index still exists, and all values
   still match.
7. Deactivate and delete it, as required by the current field deletion API.
   Assert the contribution and physical columns are gone and its numbers no
   longer match while standard-phone lookup still works.
8. Recreate the same logical field name as `TEXT`, store the same digits, and
   assert no phone contribution is created and no phone lookup matches it.
9. Delete that field and recreate it as `PHONES`, write a fresh value, and
   assert participation resumes. This is the supported test for a logical
   non-phone-to-phone transition.

Also run the reverse logical transition (`PHONES` deleted, same name recreated
as `TEXT`) as the phone-to-non-phone case. Do not attempt `updateOneField` with a
new `type`: `UpdateFieldInput` explicitly omits `type` and the editable-property
allowlist excludes it. A small API contract test may assert that GraphQL rejects
such an update, but it is not a lifecycle path the phone feature must support.

Follow the cleanup pattern in
`create-and-delete-field-metadata-search-vector-side-effect.integration-spec.ts`:
deactivate every custom field before deleting it, and use `try/finally` or
`afterAll` guards so a failed assertion does not leave custom Person schema
behind for later suites.

### Resolver integration test

Add a new suite beside
`test/integration/graphql/suites/search/search-resolver.integration-spec.ts`
and a focused GraphQL factory beside `test/integration/graphql/utils/search.util.ts`.
The fixture should include separate people whose match exists in:

- the standard primary phone;
- a standard additional phone;
- a custom primary phone;
- a custom additional phone;
- two different readable phone fields on the same Person;
- only a non-phone field containing identical digits; and
- no field.

For each valid E.164 request assert exact record IDs, stable ID pagination, and
an empty definitive miss. Add invalid input, empty input, and national input
with/without explicit country tests according to the final API contract. Spy on
or instrument the query path to assert it never invokes `SearchService`,
`buildSearchQueryAndGetRecordsWithFallback`, `LIKE`, or `ILIKE`.

### Permission integration test

Create two custom `PHONES` fields on Person, place the requested number only in
one field at a time, and exercise a role that may read one but not the other.
Assert:

- a value in the readable field returns the Person;
- the same value only in the restricted field returns no result;
- a Person with both fields still returns through the readable field;
- the generated query contains qualified tokens only for readable field IDs;
- lack of Person object-read permission is rejected; and
- row-level predicates can remove an otherwise matching Person.

This suite is essential: selecting only `id` is not sufficient protection when
the `WHERE` expression contains a generated vector built from restricted fields.

### Upgrade and regression tests

The workspace command suite should start from four states: no phone metadata,
field only, field plus index but missing contributions, and fully provisioned.
After one run all should converge; after a second run metadata IDs, expressions,
and operation counts should remain unchanged. Include pre-existing active and
inactive custom `PHONES` fields and verify only the active field contributes.

Finally assert that:

- existing generic Person search results and fallback behavior are unchanged;
- the standard Person phone field's phone-vector contribution coexists with its
  existing generic-vector contribution;
- object deletion collects the new system field/index/contributions;
- workspace export includes the second generated column and GIN index; and
- generated schema/client artifacts expose only the dedicated person-phone
  operation, not a generic object/field selector.

## Remaining decisions

- Final person-phone API name and response DTO.
- E.164-only input versus national input with an explicit ISO country code.
- Upgrade normalization strategy for legacy, non-canonical stored phones.
- Whether the first response needs the matching field identifier; returning it
  requires either a second permission-safe calculation or a richer indexed
  representation and is not necessary to return matching Person IDs.
- Operational batch/window policy for the slow workspace upgrade on the largest
  Person tables.
