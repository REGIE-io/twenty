import { FieldMetadataType } from 'twenty-shared/types';
import {
  type SearchableFieldType,
  isSearchableFieldType,
} from 'twenty-shared/utils';

// Keep Twenty's global searchable guard narrow. The projection union preserves
// compatibility with existing standard search rows, while the custom-field
// predicate below is the exact Regie approval list.
const ADDITIONAL_SEARCH_VECTOR_PROJECTION_FIELD_TYPES = [
  FieldMetadataType.NUMBER,
  FieldMetadataType.BOOLEAN,
  FieldMetadataType.DATE,
  FieldMetadataType.DATE_TIME,
  FieldMetadataType.SELECT,
  FieldMetadataType.MULTI_SELECT,
  FieldMetadataType.CURRENCY,
] as const;

export type SearchVectorProjectionFieldType =
  | SearchableFieldType
  | (typeof ADDITIONAL_SEARCH_VECTOR_PROJECTION_FIELD_TYPES)[number];

export const isSearchVectorProjectionFieldType = (
  type: FieldMetadataType,
): type is SearchVectorProjectionFieldType =>
  isSearchableFieldType(type) ||
  ADDITIONAL_SEARCH_VECTOR_PROJECTION_FIELD_TYPES.includes(
    type as (typeof ADDITIONAL_SEARCH_VECTOR_PROJECTION_FIELD_TYPES)[number],
  );

const REGIE_CUSTOM_SEARCH_FIELD_TYPES = [
  FieldMetadataType.TEXT,
  FieldMetadataType.NUMBER,
  FieldMetadataType.BOOLEAN,
  FieldMetadataType.DATE,
  FieldMetadataType.DATE_TIME,
  FieldMetadataType.SELECT,
  FieldMetadataType.MULTI_SELECT,
  FieldMetadataType.CURRENCY,
  FieldMetadataType.EMAILS,
  FieldMetadataType.PHONES,
  FieldMetadataType.LINKS,
] as const;

export type RegieCustomSearchFieldType =
  (typeof REGIE_CUSTOM_SEARCH_FIELD_TYPES)[number];

export const isRegieCustomSearchFieldType = (
  type: FieldMetadataType,
): type is RegieCustomSearchFieldType =>
  REGIE_CUSTOM_SEARCH_FIELD_TYPES.includes(type as RegieCustomSearchFieldType);
