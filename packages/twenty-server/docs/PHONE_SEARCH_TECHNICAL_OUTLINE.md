# Phone-Scoped Record Search Technical Outline

This document intentionally describes structure and sequencing only. It is not a
detailed implementation specification.

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

## Metadata model and lifecycle

Use the existing relationship between `SearchFieldMetadata` and
`tsVectorFieldMetadataId` where practical. That relationship already allows the
generated expression to be derived for a particular target vector.

Introduce engine-owned metadata side effects that:

1. Provision `phoneSearchVector` and its GIN index when an object first gains an
   eligible `PHONES` field.
2. Create a deterministic, engine-owned contribution for every active `PHONES`
   field targeting `phoneSearchVector`.
3. Rebuild only the phone vector expression when a contributing field is added,
   renamed, deleted, activated, deactivated, or changes type.
4. Remove the contribution before dropping or changing the underlying phone
   columns.
5. Delete the vector, index, and contributions with the parent object. Whether
   an empty vector/index is retained after the last phone field is removed can be
   chosen based on migration cost; it must contain no old values either way.

The generated expression should be assembled from post-change flat metadata so
that metadata migrations remain deterministic and do not read stale state.

## Phone token expression

Extend or wrap the existing `PHONES` expression builder so it can produce lookup
tokens for an arbitrary field name. Each contributing field must cover:

- primary phone number;
- primary calling-code plus number variants required by the normalization
  contract; and
- each number in the additional-phone value.

Twenty's write transformer parses valid phones with `libphonenumber-js`. It
stores `nationalNumber` in the number column/value and stores or infers the `+`
country calling code and ISO country code separately for both primary and
additional phones. The index expression must produce a canonical,
E.164-equivalent token from calling code plus national number rather than depend
on the input's display formatting.

The API parser must produce the same canonical token. The initial contract
accepts E.164 input; national-format input is unambiguous only when accompanied
by an explicit ISO country code. Query exact lexemes rather than the `:*` prefix
behavior of generic search.

### Field-permission provenance

A single unqualified phone vector would allow a readable record to be surfaced
because of a phone field the caller cannot read. Preserve field provenance in
the indexed token, for example by prefixing each phone lexeme with a stable,
token-safe encoding of its field metadata identifier.

At query time:

1. Resolve active `PHONES` fields on the target object.
2. Apply field-permission filtering.
3. Build exact query lexemes only for the permitted field identifiers and the
   normalized input representations.

The exact token encoding needs tests against PostgreSQL's `simple` parser. It
must remain a single lexeme and must not depend on a mutable field name.

## Query API and service

Add a person-specific resolver/service rather than a flag on generic search. A
tentative request contains:

- phone number;
- optional ISO country code if national-format input is supported;
- limit; and
- cursor.

The service resolves metadata and permissions, builds the permitted exact
`tsquery`, and executes the equivalent of:

```sql
WHERE "phoneSearchVector" @@ to_tsquery('simple', :phoneQuery)
```

There is no fallback query. Ranking is unnecessary for exact lookup; stable ID
ordering can provide deterministic pagination. The response can reuse existing
record-search DTOs if their semantics fit, but the operation remains distinct
from generic search.

## Record updates

Because `phoneSearchVector` is a stored generated column, PostgreSQL recalculates
it and maintains the GIN index when any referenced primary or additional phone
column changes. No application-level record-write hook should be required.

Metadata changes still require rebuilding the generated expression because the
set of referenced physical columns has changed.

## Existing-workspace rollout

Add an idempotent workspace upgrade that:

1. Finds objects with active `PHONES` fields.
2. Creates deterministic phone-vector field metadata, contribution metadata, and
   GIN index metadata.
3. Applies the workspace schema migration and builds the generated values/index.
4. Can resume safely when some metadata already exists.

Index construction and generated-column rebuilds may be expensive on large
tables. The implementation plan must select the appropriate fast/slow upgrade
phase and assess lock duration before rollout.

## Main implementation areas

- Constants/builders for the engine-owned phone vector and deterministic GIN
  index.
- Flat-metadata side effects for object and field lifecycle changes.
- Phone-only generated-expression and field-qualified token utilities.
- Workspace upgrade/backfill command.
- Dedicated GraphQL arguments, resolver, service, DTO, and generated client
  schema updates.
- Permission-aware query construction and cursor handling.

## Test outline

- Expression tests for multiple standard/custom phone fields and additional
  phones.
- Metadata side-effect tests for create, rename, delete, activation, and type
  transitions.
- Workspace migration tests proving only `phoneSearchVector` is rebuilt.
- Upgrade idempotency and partial-state recovery tests.
- Resolver integration tests for primary, additional, custom, non-phone, empty,
  and paginated cases.
- Field-permission tests proving inaccessible phone fields cannot produce a
  result.
- SQL/query-builder tests proving the dedicated path uses `@@` and never emits
  `LIKE`/`ILIKE`.
- Regression tests proving generic `search` is unchanged.

## Decisions to settle before implementation

- Final person-phone API name and response DTO.
- E.164-only input versus national input with an explicit ISO country code.
- Field-qualified lexeme encoding.
- Whether an empty phone vector remains after the last `PHONES` field is removed.
- Upgrade phase and operational strategy for large existing person tables.
