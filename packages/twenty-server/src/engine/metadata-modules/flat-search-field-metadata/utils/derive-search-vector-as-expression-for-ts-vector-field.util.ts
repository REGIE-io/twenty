import { type FieldMetadataType } from 'twenty-shared/types';
import { isDefined } from 'twenty-shared/utils';

import {
  buildSearchVectorTargetField,
  computeSearchVectorAsExpressionFromSearchFieldMetadatas,
} from 'src/engine/metadata-modules/flat-search-field-metadata/utils/compute-search-vector-as-expression-from-search-field-metadatas.util';
import { computePhoneSearchVectorAsExpressionFromSearchFieldMetadatas } from 'src/engine/metadata-modules/flat-search-field-metadata/utils/compute-phone-search-vector-as-expression-from-search-field-metadatas.util';
import { type FlatSearchFieldMetadata } from 'src/engine/metadata-modules/flat-search-field-metadata/types/flat-search-field-metadata.type';
import { PHONE_SEARCH_VECTOR_FIELD } from 'src/engine/metadata-modules/search-field-metadata/constants/phone-search-vector-field.constants';

export const deriveSearchVectorAsExpressionForTsVectorField = ({
  targetSearchFieldMetadatas,
  indexedFieldById,
  tsVectorField,
}: {
  targetSearchFieldMetadatas: FlatSearchFieldMetadata[];
  indexedFieldById: ReadonlyMap<
    string,
    { name: string; type: FieldMetadataType; universalIdentifier: string }
  >;
  tsVectorField: { name: string; universalIdentifier: string };
}): string => {
  const targetSearchableFields = targetSearchFieldMetadatas.flatMap(
    (flatSearchFieldMetadata) => {
      const indexedField = indexedFieldById.get(
        flatSearchFieldMetadata.fieldMetadataId,
      );

      if (!isDefined(indexedField)) {
        return [];
      }

      return [
        buildSearchVectorTargetField({
          field: indexedField,
          position: flatSearchFieldMetadata.position,
          sortKey: flatSearchFieldMetadata.universalIdentifier,
        }),
      ];
    },
  );

  if (tsVectorField.name === PHONE_SEARCH_VECTOR_FIELD.name) {
    return computePhoneSearchVectorAsExpressionFromSearchFieldMetadatas(
      targetSearchableFields,
    );
  }

  return computeSearchVectorAsExpressionFromSearchFieldMetadatas(
    targetSearchableFields,
  );
};
