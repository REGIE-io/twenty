import { type FieldMetadataType } from 'twenty-shared/types';
import { isSearchableFieldType } from 'twenty-shared/utils';

import { isAdditionalSearchableFieldType } from 'src/engine/workspace-manager/utils/is-additional-searchable-field-type.util';
import {
  type FieldTypeAndNameMetadata,
  getTsVectorColumnExpressionFromFields,
  type SearchableFieldOption,
} from 'src/engine/workspace-manager/utils/get-ts-vector-column-expression.util';

export type SearchVectorTargetField = {
  name: string;
  type: FieldMetadataType;
  // Dropdown options, so the expression can project labels that never reach the row.
  options?: SearchableFieldOption[];
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
    options?: SearchableFieldOption[];
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
    .flatMap((targetField): FieldTypeAndNameMetadata[] => {
      const { type } = targetField;

      // Twenty's own predicate stays narrow; marked dropdowns are admitted on top
      // of it, otherwise a registered SELECT row would be silently dropped here.
      if (
        !isSearchableFieldType(type) &&
        !isAdditionalSearchableFieldType(type)
      ) {
        return [];
      }

      return [{ name: targetField.name, type, options: targetField.options }];
    });

  return getTsVectorColumnExpressionFromFields(orderedSearchableFields);
};
