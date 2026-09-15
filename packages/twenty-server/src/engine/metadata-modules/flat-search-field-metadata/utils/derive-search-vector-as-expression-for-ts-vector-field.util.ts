import { type FieldMetadataType } from 'twenty-shared/types';
import { isDefined } from 'twenty-shared/utils';

import {
  buildSearchVectorTargetField,
  computeSearchVectorAsExpressionFromSearchFieldMetadatas,
} from 'src/engine/metadata-modules/flat-search-field-metadata/utils/compute-search-vector-as-expression-from-search-field-metadatas.util';
import { type FlatSearchFieldMetadata } from 'src/engine/metadata-modules/flat-search-field-metadata/types/flat-search-field-metadata.type';
import { type SearchableFieldOption } from 'src/engine/workspace-manager/utils/get-ts-vector-column-expression.util';
import { assertSafeTsVectorExpression } from 'src/engine/workspace-manager/workspace-migration/utils/remove-sql-injection.util';

export const deriveSearchVectorAsExpressionForTsVectorField = ({
  targetSearchFieldMetadatas,
  indexedFieldById,
}: {
  targetSearchFieldMetadatas: FlatSearchFieldMetadata[];
  indexedFieldById: ReadonlyMap<
    string,
    {
      name: string;
      type: FieldMetadataType;
      // Dropdown labels live in metadata, not the row, so the expression needs them here
      // or a registered SELECT row projects nothing.
      options?: SearchableFieldOption[];
    }
  >;
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

  const expression = computeSearchVectorAsExpressionFromSearchFieldMetadatas(
    targetSearchableFields,
  );

  assertSafeTsVectorExpression(expression);

  return expression;
};
