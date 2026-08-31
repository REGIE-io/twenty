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

Provide an indexed, object-scoped API that finds records by phone number across
all readable `PHONES` fields on the object, including fields added after the
object was created.

## Functional requirements

1. The caller can specify the target object and phone number. The initial caller
   is expected to search the `person` object.
2. Only fields whose metadata type is `PHONES` may contribute matches.
3. Every eligible `PHONES` field contributes both its primary phone and all
   additional phones.
4. Standard and custom `PHONES` fields behave identically.
5. Phone formatting differences supported by the phone normalization contract
   must not prevent a match. At minimum, compact international and national
   representations stored by Twenty must be searchable.
6. A returned record must have matched an eligible phone value. A value in a
   name, email, title, postal code, note, or any other non-phone field must never
   produce a result.
7. The query uses a PostgreSQL index for both hits and misses. It must not invoke
   the generic search service's `ILIKE` fallback.
8. An empty indexed result is definitive and returns immediately.
9. Object-, record-, and field-level read permissions are enforced. A match in a
   phone field the caller cannot read must not reveal or return the record.
10. Result limits and pagination are deterministic and cannot be consumed by
    matches from non-phone fields.
11. Creating, renaming, deleting, activating, deactivating, or changing the type
    of a custom field updates its participation without manual database work.
12. Updating a record's primary or additional phone values updates the searchable
    index as part of the same database write semantics.

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
- Removing or changing the type of that custom field removes its values from the
  lookup surface.
- The same digits in a non-phone field do not return the record.
- A caller lacking read access to the matching phone field receives no result
  from that field.
- A no-match query uses the phone index and does not contain `LIKE` or `ILIKE`.
- Existing generic-search behavior and results remain unchanged.

## Open product decisions

- Final GraphQL naming and response shape: for example,
  `searchRecordsByPhone(objectNameSingular, phoneNumber, ...)` versus a
  person-specific API.
- Whether results should identify the matching field in addition to the record.
- The authoritative normalization contract for numbers without a country code.
- Whether inactive phone fields should remain searchable for administrative
  workflows; the default requirement is no.
