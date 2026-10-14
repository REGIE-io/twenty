import {
  FieldMetadataType,
  compositeTypeDefinitions,
} from 'twenty-shared/types';
import { isDefined, type SearchableFieldType } from 'twenty-shared/utils';

import {
  computeColumnName,
  computeCompositeColumnName,
} from 'src/engine/metadata-modules/field-metadata/utils/compute-column-name.util';
import { isCompositeFieldMetadataType } from 'src/engine/metadata-modules/field-metadata/utils/is-composite-field-metadata-type.util';
import { isSearchableSubfield } from 'src/engine/workspace-manager/utils/is-searchable-subfield.util';
import { type AdditionalSearchableFieldType } from 'src/engine/workspace-manager/utils/is-additional-searchable-field-type.util';
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
  type: SearchableFieldType | AdditionalSearchableFieldType;
  options?: SearchableFieldOption[];
};

// Postgres rejects a tsvector over 1,048,575 bytes and fails the whole row write. left()
// counts characters; 131,072 keeps the worst case (distinct 4-byte-UTF-8 words) near 700KB.
export const SEARCH_VECTOR_TEXT_LIMIT = 131072;

// Postgres caps a function call at 100 arguments.
const CONCAT_WS_MAX_PIECES = 99;

type TsVectorExpressionStyle = {
  quoteColumn: (columnName: string) => string;
  unaccent: (expression: string) => string;
};

const GENERATED_COLUMN_STYLE: TsVectorExpressionStyle = {
  quoteColumn: escapeIdentifier,
  unaccent: (expression) => `public.unaccent_immutable(${expression})`,
};

// Same pieces in the same order as the generated-column formula, joined once and
// unaccented once; unaccent now also passes over phone and uuid text, a no-op for digits
// and hex. concat_ws is not immutable, so this shape only works outside a generated column.
export const getLeanTsVectorExpressionFromFields = (
  fieldsUsedForSearch: FieldTypeAndNameMetadata[],
  { columnReference }: { columnReference: 'column' | 'triggerRow' },
): string => {
  const style: TsVectorExpressionStyle = {
    quoteColumn:
      columnReference === 'triggerRow'
        ? (columnName) => `NEW.${escapeIdentifier(columnName)}`
        : escapeIdentifier,
    // unaccent runs once over the joined text below, so each piece only keeps its grouping.
    unaccent: (expression) => `(${expression})`,
  };

  const pieces = fieldsUsedForSearch.flatMap((field) =>
    getColumnExpressionsFromField(field, style),
  );

  if (pieces.length === 0) {
    return "to_tsvector('simple', NULL)";
  }

  const chunks: string[] = [];

  for (let start = 0; start < pieces.length; start += CONCAT_WS_MAX_PIECES) {
    chunks.push(
      `concat_ws(' ', ${pieces.slice(start, start + CONCAT_WS_MAX_PIECES).join(', ')})`,
    );
  }

  // One level of nesting covers 99 * 99 pieces; past that the outer call breaks the limit.
  if (chunks.length > CONCAT_WS_MAX_PIECES) {
    throw new Error(
      `Too many searchable columns for one search vector: ${pieces.length} pieces, at most ${CONCAT_WS_MAX_PIECES * CONCAT_WS_MAX_PIECES}`,
    );
  }

  return `to_tsvector('simple', public.unaccent_immutable(left(concat_ws(' ', ${chunks.join(', ')}), ${SEARCH_VECTOR_TEXT_LIMIT})))`;
};

export const getTsVectorColumnExpressionFromFields = (
  fieldsUsedForSearch: FieldTypeAndNameMetadata[],
): string => {
  const columnExpressions = fieldsUsedForSearch.flatMap((field) =>
    getColumnExpressionsFromField(field, GENERATED_COLUMN_STYLE),
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
  style: TsVectorExpressionStyle,
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

    return `COALESCE(${style.unaccent(`CASE ${quotedColumnName} ${arms} ELSE '' END`)}, '')`;
  };

  return `${buildCase((option) => option.value)} || ' ' || ${buildCase((option) => option.label)}`;
};

// MULTI_SELECT is an enum ARRAY column, so membership has to be tested per option.
const getMultiSelectExpression = (
  quotedColumnName: string,
  options: SearchableFieldOption[],
  style: TsVectorExpressionStyle,
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

    return `COALESCE(${style.unaccent(tests)}, '')`;
  };

  return `${buildTests((option) => option.value)} || ' ' || ${buildTests((option) => option.label)}`;
};

// JSON columns the expression reads beside a composite's searchable subfields (see below).
const SEARCHED_JSON_PROPERTY_NAME_BY_TYPE: Partial<
  Record<FieldMetadataType, string>
> = {
  [FieldMetadataType.PHONES]: 'additionalPhones',
  [FieldMetadataType.LINKS]: 'secondaryLinks',
  [FieldMetadataType.EMAILS]: 'additionalEmails',
};

// Every column the expression reads for a field, so a backfill can find the rows whose words it holds.
export const getSearchedColumnNamesForField = ({
  name,
  type,
}: {
  name: string;
  type: FieldMetadataType;
}): string[] => {
  const compositeType = compositeTypeDefinitions.get(type);

  if (!isCompositeFieldMetadataType(type) || !isDefined(compositeType)) {
    return [computeColumnName(name)];
  }

  return compositeType.properties
    .filter(
      (property) =>
        isSearchableSubfield(
          compositeType.type,
          property.type,
          property.name,
        ) || property.name === SEARCHED_JSON_PROPERTY_NAME_BY_TYPE[type],
    )
    .map((property) => computeCompositeColumnName(name, property));
};

const getColumnExpressionsFromField = (
  fieldMetadataTypeAndName: FieldTypeAndNameMetadata,
  style: TsVectorExpressionStyle,
): string[] => {
  // Handled before the composite branch: dropdowns need the metadata options, which the
  // shared getColumnExpression(columnName, fieldType) never receives.
  if (
    fieldMetadataTypeAndName.type === FieldMetadataType.SELECT ||
    fieldMetadataTypeAndName.type === FieldMetadataType.MULTI_SELECT
  ) {
    const quotedColumnName = style.quoteColumn(
      computeColumnName(fieldMetadataTypeAndName.name),
    );
    const options = fieldMetadataTypeAndName.options ?? [];

    return [
      fieldMetadataTypeAndName.type === FieldMetadataType.SELECT
        ? getSelectExpression(quotedColumnName, options, style)
        : getMultiSelectExpression(quotedColumnName, options, style),
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

        return getColumnExpression(
          columnName,
          fieldMetadataTypeAndName.type,
          style,
        );
      });

    if (fieldMetadataTypeAndName.type === FieldMetadataType.PHONES) {
      const phoneNumberColumn = style.quoteColumn(
        `${fieldMetadataTypeAndName.name}PrimaryPhoneNumber`,
      );
      const callingCodeColumn = style.quoteColumn(
        `${fieldMetadataTypeAndName.name}PrimaryPhoneCallingCode`,
      );
      const additionalPhonesColumn = style.quoteColumn(
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
      const secondaryLinksColumn = style.quoteColumn(
        `${fieldMetadataTypeAndName.name}SecondaryLinks`,
      );

      const secondaryLinksExpression = `COALESCE(${style.unaccent(`TRANSLATE(regexp_replace(${secondaryLinksColumn}::text, '"(label|url)"\\s*:\\s*', '', 'g'), '[]{}",:', '        ')`)}, '')`;

      return [...baseExpressions, secondaryLinksExpression];
    }

    if (fieldMetadataTypeAndName.type === FieldMetadataType.EMAILS) {
      const additionalEmailsColumn = style.quoteColumn(
        `${fieldMetadataTypeAndName.name}AdditionalEmails`,
      );

      const additionalEmailsExpression = `COALESCE(${style.unaccent(`TRANSLATE(${additionalEmailsColumn}::text, '[]",', '    ')`)}, '') || ' ' || COALESCE(${style.unaccent(`TRANSLATE(REPLACE(${additionalEmailsColumn}::text, '@', ' '), '[]",', '    ')`)}, '')`;

      return [...baseExpressions, additionalEmailsExpression];
    }

    return baseExpressions;
  }
  const columnName = computeColumnName(fieldMetadataTypeAndName.name);

  return [
    getColumnExpression(columnName, fieldMetadataTypeAndName.type, style),
  ];
};

const getColumnExpression = (
  columnName: string,
  fieldType: FieldMetadataType,
  style: TsVectorExpressionStyle,
): string => {
  const quotedColumnName = style.quoteColumn(columnName);

  switch (fieldType) {
    case FieldMetadataType.EMAILS:
      return `
      COALESCE(${style.unaccent(quotedColumnName)}, '') || ' ' ||
      COALESCE(${style.unaccent(`SPLIT_PART(${quotedColumnName}, '@', 2)`)}, '')`;

    case FieldMetadataType.PHONES:
      return `COALESCE(${quotedColumnName}, '')`;

    case FieldMetadataType.UUID:
      return `COALESCE(${quotedColumnName}::text, '')`;

    default:
      return `COALESCE(${style.unaccent(quotedColumnName)}, '')`;
  }
};
