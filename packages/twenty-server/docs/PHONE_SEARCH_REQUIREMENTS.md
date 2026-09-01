# Phone-Scoped Record Search Requirements

## Problem

Twenty's generic search API queries an object's combined `searchVector`. For a
person this vector can contain names, email addresses, phone numbers, job titles,
and other configured fields. A caller looking up a phone number therefore cannot
ask Twenty to search phone fields exclusively or determine which field produced a
match.

Generic search also runs an `ILIKE '%...%'` recovery query after an empty
full-text result. That recovery exists for natural-language tokenization cases
such as CJK text. It is unnecessary for normalized phone lookup and can scan an
entire object table on a routine miss.

## Goal

Provide a dedicated, indexed API that finds people by phone number across all
readable `PHONES` fields on the `person` object, including custom phone fields
added after the object was created. The operation accepts phone lookup input
only; it is not a generic search endpoint with an optional object or field hint.

## Availability constraint

This feature must be deployable and maintainable without an outage for normal
workspace use. Person reads, inserts, updates, and deletes—including phone
updates—must remain available while initial population, repair, cleanup, or a
phone-field metadata operation is in progress. Existing ready phone-search data
must remain queryable until its replacement is complete and atomically made
ready; an incomplete replacement must never be exposed.

Brief, bounded locks needed to install a trigger or commit metadata are allowed,
but their duration must not grow with the number of Person records. If such a
lock cannot be acquired within the configured short timeout, the operation must
retry asynchronously. No generated-column rewrite, blocking index build, table
copy/swap, or other row-count-proportional exclusive lock is permitted in the
live metadata path. It is acceptable to reject subsequent conflicting Person
schema-metadata changes with a typed retryable error while background work is
active. That gate must not block record CRUD, phone-search reads against the
last ready projection, or unrelated metadata operations.

## Functional requirements

1. The API searches the `person` object for one phone number. It does not accept
   an arbitrary search term or caller-selected target object.
2. Only fields on `person` whose metadata type is `PHONES` may contribute
   matches.
3. Every eligible `PHONES` field contributes both its primary phone and all
   additional phones.
4. Standard and custom `PHONES` fields behave identically.
5. The lookup uses the same phone parsing rules as Twenty's `PHONES` write path.
   Twenty parses valid input with `libphonenumber-js`, stores the national number
   in the number subfield, and stores or infers the `+` country calling code and
   ISO country code separately. The canonical lookup key is the E.164-equivalent
   concatenation of calling code and national number.
6. The API accepts a valid E.164 number. Supporting a national number requires an
   explicit ISO country code in the request; the API must not silently guess a
   country.
7. Display variants are not stored in the lookup index. The incoming value and
   stored phone components are independently normalized to the same canonical
   E.164-equivalent key.
8. A returned record must have matched an eligible phone value. A value in a
   name, email, title, postal code, note, or any other non-phone field must never
   produce a result.
9. The query uses a PostgreSQL index for both hits and misses. It must not invoke
   the generic search service's `ILIKE` fallback.
10. An empty indexed result is definitive and returns immediately.
11. Object-, record-, and field-level read permissions are enforced. A match in a
   phone field the caller cannot read must not reveal or return the record.
12. Result limits and pagination are deterministic and cannot be consumed by
    matches from non-phone fields.
13. Creating, renaming, deleting, activating, or deactivating a custom field
    updates its participation without manual database work. Twenty does not
    support mutating an existing field's type; changing between `PHONES` and
    another type is represented by deactivating/deleting the old field and
    creating a new field.
14. Updating a record's primary or additional phone values updates the searchable
    index as part of the same database write semantics.
15. Adding, renaming, activating, deactivating, or deleting a custom `PHONES`
    field must not rewrite the Person table or require rebuilding a shared
    Person index.
16. Initial population, repair, and field cleanup may run asynchronously, but
    ordinary Person reads and writes must remain available. Work must be
    resumable, observable, idempotent, and safe under concurrent record writes.
17. During first-time initialization, when no complete readable phone
    projection exists, the API returns a typed retryable readiness error rather
    than a false-negative empty result. A newly added field or replacement
    generation is staged outside the current ready projection until its atomic
    cutover, so an existing complete projection remains queryable.
18. Conflicting Person field-metadata changes may be temporarily rejected while
    an indexing operation is active. Record CRUD and unrelated object/metadata
    operations must continue.
19. When a ready phone projection already exists, repair or replacement work
    must build a new generation while queries continue using the ready
    generation, then switch generations atomically. Initial enablement may
    return the typed readiness error until its first generation is complete.

## Non-goals

- Changing the behavior of the existing generic `search` API.
- Removing the CJK/substring fallback from human-facing text search.
- Fuzzy, suffix, or arbitrary substring phone matching.
- Enforcing phone-number uniqueness.
- Searching fields that are not declared as `PHONES`, even when their contents
  resemble a phone number.

## Acceptance criteria

- A phone stored in the standard primary phone field is found.
- A phone stored in the standard additional-phone collection is found.
- A phone stored in the primary or additional portion of a custom `PHONES` field
  is found after that field is created.
- An E.164 lookup matches the equivalent calling-code and national-number parts
  produced by Twenty's phone write transformer.
- Deactivating or deleting that custom field removes its values from the lookup
  surface. Recreating the logical field with a non-`PHONES` type does not add
  those values back.
- The same digits in a non-phone field do not return the record.
- A caller lacking read access to the matching phone field receives no result
  from that field.
- A no-match query uses the phone index and does not contain `LIKE` or `ILIKE`.
- Existing generic-search behavior and results remain unchanged.
- A multi-batch backfill can run while Person records are read, inserted,
  updated, and deleted without missing or retaining stale phone lookup rows.
- Two concurrent Person field-metadata changes cannot create overlapping phone
  indexing operations; the losing request receives a retryable busy response.
- A Redis flush, duplicate queue delivery, worker crash, or server restart does
  not lose progress or expose incomplete lookup data as ready.
- During repair of an already-ready projection, concurrent phone queries and
  Person CRUD continue successfully against a complete generation; cutover does
  not require a table swap or row-count-proportional lock.

## Open product decisions

- Final GraphQL naming and response shape: for example,
  `searchPeopleByPhone(phoneNumber, countryCode, ...)` versus
  `findPeopleByPhone(...)`.
- Whether results should identify the matching field in addition to the record.
- Whether national-format input is needed in the first version; if it is, the
  request must carry its ISO country context.
- Whether inactive phone fields should remain searchable for administrative
  workflows; the default requirement is no.
