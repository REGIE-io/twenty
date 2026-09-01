import { FieldMetadataType } from 'twenty-shared/types';

import {
  escapeIdentifier,
  escapeLiteral,
} from 'src/engine/workspace-manager/workspace-migration/utils/remove-sql-injection.util';

type PhoneSearchVectorTargetField = {
  name: string;
  type: FieldMetadataType;
  universalIdentifier: string;
  position: number;
  sortKey: string;
};

// Produces field-qualified canonical phone lexemes through the immutable database
// helper. The helper owns JSON expansion and validation for generated columns.
export const computePhoneSearchVectorAsExpressionFromSearchFieldMetadatas = (
  targetFields: PhoneSearchVectorTargetField[],
): string => {
  const expressions = [...targetFields]
    .filter((field) => field.type === FieldMetadataType.PHONES)
    .sort((a, b) =>
      a.position === b.position
        ? a.sortKey.localeCompare(b.sortKey)
        : a.position - b.position,
    )
    .map((field) => {
      const fieldKey = field.universalIdentifier;
      const callingCodeColumn = escapeIdentifier(
        `${field.name}PrimaryPhoneCallingCode`,
      );
      const numberColumn = escapeIdentifier(`${field.name}PrimaryPhoneNumber`);
      const additionalPhonesColumn = escapeIdentifier(
        `${field.name}AdditionalPhones`,
      );

      return `public.phone_search_tokens(${escapeLiteral(fieldKey)}, ${callingCodeColumn}, ${numberColumn}, ${additionalPhonesColumn})`;
    });

  return `to_tsvector('simple', ${
    expressions.length === 0
      ? 'NULL'
      : expressions.map((expression) => `COALESCE(${expression}, '')`).join(" || ' ' || ")
  })`;
};
