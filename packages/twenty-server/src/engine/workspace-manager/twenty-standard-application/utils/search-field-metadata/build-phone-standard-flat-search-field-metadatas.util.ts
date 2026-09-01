import { type FlatSearchFieldMetadata } from 'src/engine/metadata-modules/flat-search-field-metadata/types/flat-search-field-metadata.type';
import { PHONE_SEARCH_VECTOR_FIELD } from 'src/engine/metadata-modules/search-field-metadata/constants/phone-search-vector-field.constants';
import {
  type CreateStandardSearchFieldArgs,
  createStandardSearchFieldFlatMetadata,
} from 'src/engine/workspace-manager/twenty-standard-application/utils/search-field-metadata/create-standard-search-field-flat-metadata.util';

// The generic search-field builder intentionally targets searchVector. Keep this
// separate so the phone-only surface cannot accidentally affect generic search.
export const buildPhoneStandardFlatSearchFieldMetadatas = (
  args: Omit<CreateStandardSearchFieldArgs<'person'>, 'context'>,
): FlatSearchFieldMetadata[] => [
  createStandardSearchFieldFlatMetadata({
    ...args,
    objectName: 'person',
    context: {
      fieldName: 'phones',
      position: 0,
      tsVectorFieldName: PHONE_SEARCH_VECTOR_FIELD.name,
      useTargetAwareIdentifier: true,
    },
  }),
];
