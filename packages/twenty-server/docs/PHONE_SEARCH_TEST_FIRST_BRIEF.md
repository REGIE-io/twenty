# Phone Search Test-First Implementation Brief

## Assignment

Build the focused tests and test utilities for phone-scoped search before the
production implementation. The resulting suites should be runnable by exact
paths so they form a small acceptance target for subsequent implementation.

Do not implement the search vector, endpoint, metadata side effects, or upgrade
in this task. It is expected that the new acceptance tests are red because the
API and metadata do not exist yet. They must still compile, set up and tear down
their own fixtures correctly, and fail for the missing behavior rather than for
an accidental fixture or TypeScript error.

Read these contracts first:

- `packages/twenty-server/docs/PHONE_SEARCH_REQUIREMENTS.md`
- `packages/twenty-server/docs/PHONE_SEARCH_TECHNICAL_OUTLINE.md`

## API contract to test

Fix the first test contract to this GraphQL shape so implementation has a clear
target:

```graphql
query SearchPeopleByPhone(
  $phoneNumber: String!
  $countryCode: String
  $limit: Int!
  $after: String
) {
  searchPeopleByPhone(
    phoneNumber: $phoneNumber
    countryCode: $countryCode
    limit: $limit
    after: $after
  ) {
    edges {
      node {
        recordId
      }
      cursor
    }
    pageInfo {
      endCursor
      hasNextPage
    }
  }
}
```

The operation is Person-only and phone-only:

- It has no object selector, field selector, or arbitrary text input.
- `recordId` is a Person record ID.
- Matching is exact after canonical phone parsing.
- Both primary and additional entries of every active, readable Person
  `PHONES` field participate.
- No Company/account or non-phone field may produce a result.
- Result order is ascending Person ID for deterministic cursor pagination.
- An empty indexed result is final; there is no generic-search/`ILIKE` fallback.

The test factory may submit this raw operation before generated GraphQL client
artifacts exist. Put it beside `test/integration/graphql/utils/search.util.ts`,
for example as `search-people-by-phone.util.ts`.

## Required fixture topology

Use real metadata GraphQL helpers and record mutations. Do not mock field
metadata or directly add workspace columns with ad hoc SQL.

Create two active custom `PHONES` fields on standard Person, for example
`alternatePhonesOne` and `alternatePhonesTwo`. Also create an active custom
`PHONES` field on standard Company, which is the account-like object in Twenty.
The Company field is an isolation fixture: under the Person-only API, its values
must never be returned. If product scope changes so Company phone values should
be positive results, stop and revise the API contract rather than silently
broadening these tests.

Create Persons that isolate these cases with globally distinct valid E.164
numbers:

1. Standard `phones.primaryPhoneNumber` only.
2. Standard `phones.additionalPhones` only.
3. Both standard primary and additional values, using different numbers.
4. The same canonical number in both standard primary and additional entries;
   the Person must appear once.
5. Custom field one primary only.
6. Custom field one additional only.
7. Custom field two primary only.
8. Custom field two additional only.
9. Different numbers in both custom fields.
10. One number repeated in both custom fields; the Person must appear once.
11. Values in standard plus both custom fields.
12. No phone fields, but identical digits in a non-phone Person field such as
    `jobTitle`; this must not match.

Create Companies/accounts with:

- a phone in the custom Company `PHONES` primary entry;
- a phone in its additional entry; and
- a number identical to one stored on a Person.

Searching a Company-only number must return no Person. Searching the shared
number must return only the matching Person ID, proving the endpoint did not
search or union Company records.

Pass values through Twenty's normal phone record input so the write transformer
stores national number, calling code, country, and additional JSON in the real
format. Do not precompute or write `phoneSearchVector` in fixture setup.

## Search acceptance suite

Create:

`test/integration/graphql/suites/search/search-people-by-phone-resolver.integration-spec.ts`

At minimum test:

- every isolated standard/custom primary and additional fixture above;
- a Person with values in one, the other, and both custom phone fields;
- deduplication when the number appears in multiple eligible fields;
- non-phone Person digits do not match;
- Company/account phone values do not match;
- formatted E.164 input resolves to the stored canonical value;
- invalid input is rejected;
- national input without country context is rejected;
- national input with country context, if retained in the API, matches;
- missing number returns an empty connection;
- `limit + cursor` pagination has stable ascending-ID results without duplicates;
- primary/additional record updates become searchable and removed values stop
  matching; and
- generic `search` behavior is unchanged for at least one control fixture.

Prefer table-driven cases for the repeated number-to-record assertions. Assert
the complete ordered ID array, not only `toContain`, so unrelated matches and
duplicates fail the suite.

## Custom-field lifecycle suite

Create:

`test/integration/metadata/suites/field-metadata/person-phone-search-field-lifecycle.integration-spec.ts`

Exercise this ordered lifecycle using a third custom Person `PHONES` field:

1. Create field, populate primary and additional values, and find each value.
2. Deactivate field and verify neither value is found.
3. Reactivate field and verify retained values are found again.
4. Rename field and verify values remain findable.
5. Deactivate and delete field and verify values are no longer findable.
6. Recreate the same logical name as `TEXT`, store phone-like digits, and verify
   it does not participate.
7. Delete the text field, recreate it as `PHONES`, populate a new value, and
   verify the new value is found.

Twenty cannot mutate an existing field's `type`: `UpdateFieldInput` omits it and
the editable-property allowlist excludes it. Model `TEXT` to/from `PHONES` as
deactivate/delete/recreate. An API-schema assertion that an in-place type update
is rejected is useful, but do not invent type-mutation support.

The lifecycle suite may initially fail at its first phone-search assertion. Keep
all later assertions in the code so it becomes a complete target as production
pieces land.

## Permission cases

If the existing integration helpers make role/field restrictions practical
without building new infrastructure, include a focused suite or cases proving:

- number only in readable custom phone field returns Person;
- number only in restricted custom phone field does not return Person; and
- the same number in both returns Person once through the readable field.

If that setup is materially separate, leave a clearly named `it.todo` with the
exact three cases and explain the missing fixture helper. Do not mark ordinary
search and lifecycle cases as skipped or todo.

## Setup and cleanup rules

- Follow the fixture style in
  `test/integration/graphql/suites/search/search-resolver.integration-spec.ts`.
- Reuse `createOneFieldMetadata`, `updateOneFieldMetadata`, and
  `deleteOneFieldMetadata` from the metadata integration utilities.
- Custom fields must be deactivated before deletion.
- Track every created field and record. Cleanup must be safe after partial
  setup; use guarded `afterAll` cleanup and remove records before their fields.
- Use unique field names and phone values so parallel or failed local runs do
  not collide with existing fixtures.
- Do not delete all shared Person/Company records or mutate existing standard
  fixtures globally. These suites should own only what they create.
- Do not use timing sleeps. Wait only through existing metadata/job helpers when
  the API requires it.

## Isolated commands

The author must verify that Jest discovers only these suites with exact paths.
From `packages/twenty-server`, the acceptance command should be equivalent to:

```bash
NODE_ENV=test NODE_OPTIONS="--max-old-space-size=6144" \
  nx jest --config ./jest-integration.config.ts --runInBand --runTestsByPath \
  test/integration/graphql/suites/search/search-people-by-phone-resolver.integration-spec.ts \
  test/integration/metadata/suites/field-metadata/person-phone-search-field-lifecycle.integration-spec.ts
```

The database must already be in the normal integration-test state. When a reset
is needed, use the repository's existing `nx database:reset` workflow before
the focused command; do not embed a reset inside the suites.

Also report a discovery-only/list command if supported by the installed Jest
version, and record the exact red failure after fixture setup. The expected red
reason is the absent `searchPeopleByPhone` GraphQL operation or missing phone
metadata—not syntax, type checking, leaked setup, or cleanup errors.

## Deliverables

- Focused GraphQL request utility.
- Search acceptance integration suite.
- Custom-field lifecycle integration suite.
- Any small fixture builder local to these suites.
- Exact isolated test command and observed red result.
- A short coverage map from each requirement to its test name.

Do not alter unrelated tests or production behavior. Preserve unrelated working
tree files.
