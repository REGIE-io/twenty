import {
  type FieldMetadataOptions,
  type FieldMetadataType,
} from 'twenty-shared/types';

import {
  type FieldTypeAndNameMetadata,
  getTsVectorColumnExpressionFromFields,
} from 'src/engine/workspace-manager/utils/get-ts-vector-column-expression.util';
import { isSearchVectorProjectionFieldType } from 'src/engine/workspace-manager/utils/is-regie-search-vector-projection-field-type.util';

export type SearchVectorTargetField = {
  name: string;
  type: FieldMetadataType;
  options?: FieldMetadataOptions;
  // Per-object ordinal from the searchFieldMetadata row, driving deterministic order.
  position: number;
  // Tie-break for rows sharing a position (searchFieldMetadata universalIdentifier).
  sortKey: string;
};

export const buildSearchVectorTargetField = ({
  field,
  position,
  sortKey,
}: {
  field: {
    name: string;
    type: FieldMetadataType;
    options?: FieldMetadataOptions;
  };
  position: number;
  sortKey: string;
}): SearchVectorTargetField => ({
  name: field.name,
  type: field.type,
  options: field.options,
  position,
  sortKey,
});

// Builds the searchVector to_tsvector asExpression from an object's targeted fields.
// Callers MUST pass the POST-change field set (account for rows added/removed in the
// same operation), not re-read stale maps. Ordering is deterministic only to minimize
// asExpression churn — tsvector matching is order-insensitive.
export const computeSearchVectorAsExpressionFromSearchFieldMetadatas = (
  targetSearchableFields: SearchVectorTargetField[],
): string => {
  const orderedSearchableFields: FieldTypeAndNameMetadata[] = [
    ...targetSearchableFields,
  ]
    .sort((a, b) => {
      if (a.position !== b.position) {
        return a.position - b.position;
      }

      return a.sortKey < b.sortKey ? -1 : a.sortKey > b.sortKey ? 1 : 0;
    })
    .flatMap((targetField) =>
      isSearchVectorProjectionFieldType(targetField.type)
        ? [
            {
              name: targetField.name,
              type: targetField.type,
              options: targetField.options,
            },
          ]
        : [],
    );

  return getTsVectorColumnExpressionFromFields(orderedSearchableFields);
};
