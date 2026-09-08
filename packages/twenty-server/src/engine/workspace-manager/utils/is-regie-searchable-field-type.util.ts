import { FieldMetadataType } from 'twenty-shared/types';

// Twenty's own searchable guard stays narrow on purpose: widening it would make standard
// select fields on stock objects searchable, changing index contents for records this
// project never intended to touch. These two are admitted here so a Regie-marked dropdown
// can be projected at all; whether a given field is actually indexed is decided by the
// marker at the registration site, not by this predicate, which only sees a type.
const REGIE_ONLY_SEARCHABLE_FIELD_TYPES = [
  FieldMetadataType.SELECT,
  FieldMetadataType.MULTI_SELECT,
] as const;

export type RegieSearchableFieldType =
  | FieldMetadataType.TEXT
  | FieldMetadataType.EMAILS
  | FieldMetadataType.PHONES
  | FieldMetadataType.LINKS
  | (typeof REGIE_ONLY_SEARCHABLE_FIELD_TYPES)[number];

// The four non-dropdown types are listed out rather than delegating to
// isSearchableFieldType, which also admits FULL_NAME, ADDRESS, RICH_TEXT and UUID. Those are
// not Regie custom field types, and delegating would silently readmit them the next time
// someone shortens this to `isSearchableFieldType(type) || SELECT || MULTI_SELECT`.
const REGIE_SEARCHABLE_FIELD_TYPES = new Set<FieldMetadataType>([
  FieldMetadataType.TEXT,
  FieldMetadataType.EMAILS,
  FieldMetadataType.PHONES,
  FieldMetadataType.LINKS,
  ...REGIE_ONLY_SEARCHABLE_FIELD_TYPES,
]);

export const isRegieSearchableFieldType = (
  type: FieldMetadataType,
): type is RegieSearchableFieldType => REGIE_SEARCHABLE_FIELD_TYPES.has(type);
