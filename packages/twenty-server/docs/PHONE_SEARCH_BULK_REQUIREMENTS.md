# Bulk person phone search requirements

## Goal

Add a bulk companion to `searchPeopleByPhone` that accepts between 1 and 100
phone lookups and reports the matching Person records independently for every
input. The endpoint must make ambiguity explicit: if the same number belongs to
two people, both Person IDs appear in that number's result.

This is a new endpoint rather than a list-valued option on the singular query.
`searchPeopleByPhone` remains unchanged for interactive lookup and pagination.

## GraphQL contract

```graphql
enum PhoneSearchLookupStatus {
  FOUND
  NOT_FOUND
  INVALID
}

input PhoneSearchLookupInput {
  clientReference: String!
  phoneNumber: String!
}

type PhoneSearchLookupError {
  code: String!
  message: String!
}

type PhoneSearchLookupResult {
  clientReference: String!
  phoneNumber: String!
  status: PhoneSearchLookupStatus!
  matches: [PhoneSearchRecord!]!
  hasMore: Boolean!
  error: PhoneSearchLookupError
}

type BulkPhoneSearchResult {
  results: [PhoneSearchLookupResult!]!
}

extend type Query {
  searchPeopleByPhones(
    lookups: [PhoneSearchLookupInput!]!
    matchLimitPerPhone: Int = 10
  ): BulkPhoneSearchResult!
}
```

`PhoneSearchRecord` is the existing `{ recordId: UUID! }` type from the singular
endpoint.

## Input rules

- `lookups` must contain 1 through 100 items.
- `clientReference` must be non-empty, no longer than 128 characters, and unique
  within a request. It is opaque to Twenty.
- Duplicate phone numbers are allowed when their client references differ.
- `matchLimitPerPhone` defaults to 10 and must be between 1 and 100.
- A valid phone number is strict E.164 input under the same canonicalization
  contract as `searchPeopleByPhone`.
- An invalid individual phone number produces an `INVALID` item; it does not
  prevent valid items in the same request from being searched.
- Structural errors, including an empty or oversized batch, duplicate client
  references, or an invalid match limit, reject the whole GraphQL operation as
  `BAD_USER_INPUT`.

## Output rules

- `results` has exactly one item per input, in input order.
- `clientReference` and `phoneNumber` echo the input verbatim.
- `FOUND` has one or more matches and no error.
- `NOT_FOUND` has an empty match list, `hasMore: false`, and no error.
- `INVALID` has an empty match list, `hasMore: false`, and an error with code
  `INVALID_PHONE_NUMBER`.
- Matches are distinct Person IDs ordered ascending. A Person appears once even
  when the number occurs in the primary and additional portions of one field or
  in several readable `PHONES` fields.
- One Person may appear in several result items when that Person has several of
  the requested numbers.
- Different people with the same number all appear in that number's result.
- At most `matchLimitPerPhone` Person records are returned for one number.
  `hasMore` is true when at least one additional permitted match exists.
- Matching field identity and stored phone values are not returned. This keeps
  the field-permission boundary established by the singular endpoint.

If the phone projection has no complete generation, the whole request returns
the existing retryable `PHONE_SEARCH_INDEXING` error and `retryAfter: 5`.
Readiness is workspace-wide, so it is not represented as an individual item.

## Search and permission semantics

- Search only active, readable Person fields whose metadata type is `PHONES`.
- Search primary and additional values in standard and custom phone fields.
- Do not search Company phone fields or any non-phone Person field.
- Apply object-, record-, and field-level read permissions exactly as the
  singular endpoint does.
- An empty permitted result is definitive. Never call generic search or its
  `ILIKE` fallback.

## Query and performance requirements

The endpoint must not invoke the singular service once per input. It should:

1. canonicalize all inputs in TypeScript;
2. deduplicate valid canonical values for database work;
3. resolve readiness and readable field IDs once;
4. issue one permission-aware indexed match query;
5. group matches back onto every original input and preserve input order.

The match query uses the existing
`IDX_PERSON_PHONE_LOOKUP_LOOKUP (workspaceId, objectMetadataId,
canonicalPhone, ...)` index. Its permission-aware inner result produces
distinct `(canonicalPhone, recordId)` pairs, then applies
`row_number() over (partition by canonicalPhone order by recordId)` and retains
`matchLimitPerPhone + 1` rows per canonical number. The extra row determines
`hasMore` without an unbounded count.

At maximum settings, application memory and database output are bounded by 100
inputs and 10,100 candidate rows. Duplicate inputs must not multiply database
work.

## Acceptance tests

- One number stored on two different people returns both people in one result.
- One person with two requested numbers appears in both corresponding results.
- Two different requested numbers stored on two different people map to the
  correct people in one bulk request.
- Standard primary, standard additional, and custom primary/additional values
  are found.
- Repeating a number in several phone fields on one Person does not duplicate
  that Person.
- A value found only in a restricted phone field is not returned.
- Record-level predicates remove non-readable matching people.
- Matching text in a non-phone Person field and a matching Company phone do not
  produce results.
- Mixed found, missing, and invalid items return independent statuses in input
  order.
- Duplicate phone inputs retain separate client references while sharing the
  same matches.
- A batch of 100 is accepted and a batch of 101 is rejected.
- A common number is truncated per number and reports `hasMore: true`.
- Input canonical values are queried once, through the existing B-tree, for
  both hits and misses; generated SQL contains no `LIKE` or `ILIKE`.
- Existing singular endpoint behavior and tests remain unchanged.
