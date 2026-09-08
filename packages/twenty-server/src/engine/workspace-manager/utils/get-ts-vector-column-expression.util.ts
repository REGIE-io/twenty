import {
  FieldMetadataType,
  compositeTypeDefinitions,
} from 'twenty-shared/types';
import type { SearchableFieldType } from 'twenty-shared/utils';

import {
  computeColumnName,
  computeCompositeColumnName,
} from 'src/engine/metadata-modules/field-metadata/utils/compute-column-name.util';
import { isCompositeFieldMetadataType } from 'src/engine/metadata-modules/field-metadata/utils/is-composite-field-metadata-type.util';
import { isSearchableSubfield } from 'src/engine/workspace-manager/utils/is-searchable-subfield.util';
import { type RegieSearchableFieldType } from 'src/engine/workspace-manager/utils/is-regie-searchable-field-type.util';
import {
  escapeIdentifier,
  escapeLiteral,
} from 'src/engine/workspace-manager/workspace-migration/utils/remove-sql-injection.util';

// A dropdown option as the search expression needs it: the stored enum value plus the
// human label, which lives in field metadata and never in the row.
export type SearchableFieldOption = {
  value: string;
  label: string;
  position: number;
};

export type FieldTypeAndNameMetadata = {
  name: string;
  type: SearchableFieldType | RegieSearchableFieldType;
  options?: SearchableFieldOption[];
};

export const getTsVectorColumnExpressionFromFields = (
  fieldsUsedForSearch: FieldTypeAndNameMetadata[],
): string => {
  const columnExpressions = fieldsUsedForSearch.flatMap(
    getColumnExpressionsFromField,
  );
  const concatenatedExpression =
    columnExpressions.length > 0
      ? columnExpressions.join(" || ' ' || ")
      : 'NULL';

  return `to_tsvector('simple', ${concatenatedExpression})`;
};

// isSafeTsVectorExpression scans the whole expression for these tokens without tracking
// string context, so they cannot appear even inside a quoted literal. to_tsvector('simple')
// discards punctuation anyway, so replacing them with a space loses nothing searchable.
const TS_VECTOR_UNSAFE_PATTERN = /\0|;|--|\/\*|\*\/|\$/g;

const sanitiseForTsVector = (value: string): string =>
  // replace with a /g regex rather than replaceAll: the server's lib target predates it.
  value.replace(TS_VECTOR_UNSAFE_PATTERN, ' ');

// Projected text is rewritten; a comparison literal never is. An option value is the enum
// comparison literal, so rewriting it would turn an out-of-range value into a *different*
// literal that is not a label of the generated enum, and the DDL would fail with "invalid
// input value for enum". Left alone, the same value is rejected cleanly upstream by
// assertSafeTsVectorExpression. Labels are only ever projected constants, so rewriting them
// is exactly right.
const quoteComparisonLiteral = (value: string): string => escapeLiteral(value);

const quoteProjectedText = (value: string): string =>
  escapeLiteral(sanitiseForTsVector(value));

// Emit in metadata position order so the generated expression is stable across rebuilds;
// value is only a tie-break for options sharing a position.
const orderOptions = (
  options: SearchableFieldOption[],
): SearchableFieldOption[] =>
  [...options].sort((a, b) => {
    if (a.position !== b.position) {
      return a.position - b.position;
    }

    return a.value < b.value ? -1 : a.value > b.value ? 1 : 0;
  });

const EMPTY_PROJECTION = "''";

// SELECT is a single Postgres enum column: map each option to its own value and its label.
const getSelectExpression = (
  quotedColumnName: string,
  options: SearchableFieldOption[],
): string => {
  const orderedOptions = orderOptions(options);

  if (orderedOptions.length === 0) {
    return EMPTY_PROJECTION;
  }

  const buildCase = (
    pick: (option: SearchableFieldOption) => string,
  ): string => {
    const arms = orderedOptions
      .map(
        (option) =>
          `WHEN ${quoteComparisonLiteral(option.value)} THEN ${quoteProjectedText(pick(option))}`,
      )
      .join(' ');

    return `COALESCE(public.unaccent_immutable(CASE ${quotedColumnName} ${arms} ELSE '' END), '')`;
  };

  return `${buildCase((option) => option.value)} || ' ' || ${buildCase((option) => option.label)}`;
};

// MULTI_SELECT is an enum ARRAY column, so membership has to be tested per option.
const getMultiSelectExpression = (
  quotedColumnName: string,
  options: SearchableFieldOption[],
): string => {
  const orderedOptions = orderOptions(options);

  if (orderedOptions.length === 0) {
    return EMPTY_PROJECTION;
  }

  const buildTests = (
    pick: (option: SearchableFieldOption) => string,
  ): string => {
    const tests = orderedOptions
      .map(
        (option) =>
          `CASE WHEN ${quoteComparisonLiteral(option.value)} = ANY(${quotedColumnName}) THEN ${quoteProjectedText(pick(option))} ELSE '' END`,
      )
      .join(" || ' ' || ");

    return `COALESCE(public.unaccent_immutable(${tests}), '')`;
  };

  return `${buildTests((option) => option.value)} || ' ' || ${buildTests((option) => option.label)}`;
};

const getColumnExpressionsFromField = (
  fieldMetadataTypeAndName: FieldTypeAndNameMetadata,
): string[] => {
  // Handled before the composite branch: dropdowns need the metadata options, which the
  // shared getColumnExpression(columnName, fieldType) never receives.
  if (
    fieldMetadataTypeAndName.type === FieldMetadataType.SELECT ||
    fieldMetadataTypeAndName.type === FieldMetadataType.MULTI_SELECT
  ) {
    const quotedColumnName = escapeIdentifier(
      computeColumnName(fieldMetadataTypeAndName.name),
    );
    const options = fieldMetadataTypeAndName.options ?? [];

    return [
      fieldMetadataTypeAndName.type === FieldMetadataType.SELECT
        ? getSelectExpression(quotedColumnName, options)
        : getMultiSelectExpression(quotedColumnName, options),
    ];
  }

  if (isCompositeFieldMetadataType(fieldMetadataTypeAndName.type)) {
    const compositeType = compositeTypeDefinitions.get(
      fieldMetadataTypeAndName.type,
    );

    if (!compositeType) {
      throw new Error(
        `Composite type not found for field metadata type: ${fieldMetadataTypeAndName.type}`,
      );
    }

    const baseExpressions = compositeType.properties
      .filter((property) =>
        isSearchableSubfield(compositeType.type, property.type, property.name),
      )
      .map((property) => {
        const columnName = computeCompositeColumnName(
          fieldMetadataTypeAndName,
          property,
        );

        return getColumnExpression(columnName, fieldMetadataTypeAndName.type);
      });

    if (fieldMetadataTypeAndName.type === FieldMetadataType.PHONES) {
      const phoneNumberColumn = escapeIdentifier(
        `${fieldMetadataTypeAndName.name}PrimaryPhoneNumber`,
      );
      const callingCodeColumn = escapeIdentifier(
        `${fieldMetadataTypeAndName.name}PrimaryPhoneCallingCode`,
      );
      const additionalPhonesColumn = escapeIdentifier(
        `${fieldMetadataTypeAndName.name}AdditionalPhones`,
      );

      const internationalFormats = [
        `COALESCE(${callingCodeColumn} || ${phoneNumberColumn}, '')`,
        `COALESCE(REPLACE(${callingCodeColumn}, '+', '') || ${phoneNumberColumn}, '')`,
        `COALESCE('0' || ${phoneNumberColumn}, '')`,
      ];

      const additionalPhonesExpression = `COALESCE(TRANSLATE(regexp_replace(${additionalPhonesColumn}::text, '"(number|countryCode|callingCode)"\\s*:\\s*', '', 'g'), '[]{}",:', '        '), '')`;

      return [
        ...baseExpressions,
        ...internationalFormats,
        additionalPhonesExpression,
      ];
    }

    if (fieldMetadataTypeAndName.type === FieldMetadataType.LINKS) {
      const secondaryLinksColumn = escapeIdentifier(
        `${fieldMetadataTypeAndName.name}SecondaryLinks`,
      );

      const secondaryLinksExpression = `COALESCE(public.unaccent_immutable(TRANSLATE(regexp_replace(${secondaryLinksColumn}::text, '"(label|url)"\\s*:\\s*', '', 'g'), '[]{}",:', '        ')), '')`;

      return [...baseExpressions, secondaryLinksExpression];
    }

    if (fieldMetadataTypeAndName.type === FieldMetadataType.EMAILS) {
      const additionalEmailsColumn = escapeIdentifier(
        `${fieldMetadataTypeAndName.name}AdditionalEmails`,
      );

      const additionalEmailsExpression = `COALESCE(public.unaccent_immutable(TRANSLATE(${additionalEmailsColumn}::text, '[]",', '    ')), '') || ' ' || COALESCE(public.unaccent_immutable(TRANSLATE(REPLACE(${additionalEmailsColumn}::text, '@', ' '), '[]",', '    ')), '')`;

      return [...baseExpressions, additionalEmailsExpression];
    }

    return baseExpressions;
  }
  const columnName = computeColumnName(fieldMetadataTypeAndName.name);

  return [getColumnExpression(columnName, fieldMetadataTypeAndName.type)];
};

const getColumnExpression = (
  columnName: string,
  fieldType: FieldMetadataType,
): string => {
  const quotedColumnName = escapeIdentifier(columnName);

  switch (fieldType) {
    case FieldMetadataType.EMAILS:
      return `
      COALESCE(public.unaccent_immutable(${quotedColumnName}), '') || ' ' ||
      COALESCE(public.unaccent_immutable(SPLIT_PART(${quotedColumnName}, '@', 2)), '')`;

    case FieldMetadataType.PHONES:
      return `COALESCE(${quotedColumnName}, '')`;

    case FieldMetadataType.UUID:
      return `COALESCE(${quotedColumnName}::text, '')`;

    default:
      return `COALESCE(public.unaccent_immutable(${quotedColumnName}), '')`;
  }
};
