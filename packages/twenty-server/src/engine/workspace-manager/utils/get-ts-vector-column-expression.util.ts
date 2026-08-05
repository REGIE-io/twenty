import {
  FieldMetadataType,
  compositeTypeDefinitions,
  type FieldMetadataOptions,
} from 'twenty-shared/types';

import {
  computeColumnName,
  computeCompositeColumnName,
} from 'src/engine/metadata-modules/field-metadata/utils/compute-column-name.util';
import { isCompositeFieldMetadataType } from 'src/engine/metadata-modules/field-metadata/utils/is-composite-field-metadata-type.util';
import { isSearchableSubfield } from 'src/engine/workspace-manager/utils/is-searchable-subfield.util';
import { type SearchVectorProjectionFieldType } from 'src/engine/workspace-manager/utils/is-regie-search-vector-projection-field-type.util';
import {
  escapeIdentifier,
  escapeLiteral,
} from 'src/engine/workspace-manager/workspace-migration/utils/remove-sql-injection.util';

export type FieldTypeAndNameMetadata = {
  name: string;
  type: SearchVectorProjectionFieldType;
  options?: FieldMetadataOptions;
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

const getColumnExpressionsFromField = (
  fieldMetadataTypeAndName: FieldTypeAndNameMetadata,
): string[] => {
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

    if (fieldMetadataTypeAndName.type === FieldMetadataType.CURRENCY) {
      const amountMicrosColumn = computeCompositeColumnName(
        fieldMetadataTypeAndName,
        {
          name: 'amountMicros',
          type: FieldMetadataType.NUMERIC,
          hidden: false,
          isRequired: false,
        },
      );
      return [
        ...baseExpressions,
        `COALESCE((${escapeIdentifier(amountMicrosColumn)}::numeric / 1000000)::text, '')`,
      ];
    }

    return baseExpressions;
  }
  const columnName = computeColumnName(fieldMetadataTypeAndName.name);

  if (
    fieldMetadataTypeAndName.type === FieldMetadataType.SELECT &&
    Array.isArray(fieldMetadataTypeAndName.options) &&
    fieldMetadataTypeAndName.options.length > 0
  ) {
    const quotedColumnName = escapeIdentifier(columnName);
    const valueCases = fieldMetadataTypeAndName.options
      .map(
        (option) =>
          `WHEN ${escapeLiteral(option.value)} THEN ${escapeLiteral(option.value)}`,
      )
      .join(' ');
    const labelCases = fieldMetadataTypeAndName.options
      .map(
        (option) =>
          `WHEN ${escapeLiteral(option.value)} THEN ${escapeLiteral(option.label)}`,
      )
      .join(' ');
    return [
      `COALESCE(public.unaccent_immutable(CASE ${quotedColumnName} ${valueCases} ELSE '' END), '') || ' ' || COALESCE(public.unaccent_immutable(CASE ${quotedColumnName} ${labelCases} ELSE '' END), '')`,
    ];
  }

  if (
    fieldMetadataTypeAndName.type === FieldMetadataType.MULTI_SELECT &&
    Array.isArray(fieldMetadataTypeAndName.options)
  ) {
    return [
      getMultiSelectColumnExpression(
        columnName,
        fieldMetadataTypeAndName.options,
      ),
    ];
  }

  return [getColumnExpression(columnName, fieldMetadataTypeAndName.type)];
};

const getMultiSelectColumnExpression = (
  columnName: string,
  options: NonNullable<FieldMetadataOptions>,
): string => {
  const quotedColumnName = escapeIdentifier(columnName);
  const orderedOptions = [...options].sort((left, right) => {
    if (left.position !== right.position) return left.position - right.position;
    const leftId = left.id ?? '';
    const rightId = right.id ?? '';
    if (leftId !== rightId) return leftId < rightId ? -1 : 1;
    return left.value < right.value ? -1 : left.value > right.value ? 1 : 0;
  });
  const values = orderedOptions.map(
    (option) =>
      `CASE WHEN ${escapeLiteral(option.value)} = ANY(${quotedColumnName}) THEN ${escapeLiteral(option.value)} ELSE '' END`,
  );
  const labels = orderedOptions.map(
    (option) =>
      `CASE WHEN ${escapeLiteral(option.value)} = ANY(${quotedColumnName}) THEN ${escapeLiteral(option.label)} ELSE '' END`,
  );
  if (values.length === 0) return `''`;

  return `COALESCE(public.unaccent_immutable(${values.join(" || ' ' || ")}), '') || ' ' || COALESCE(public.unaccent_immutable(${labels.join(" || ' ' || ")}), '')`;
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

    case FieldMetadataType.NUMBER:
    case FieldMetadataType.NUMERIC:
    case FieldMetadataType.BOOLEAN:
      return `COALESCE(${quotedColumnName}::text, '')`;

    case FieldMetadataType.DATE:
      return getIsoDateExpression(quotedColumnName);

    case FieldMetadataType.DATE_TIME:
      return getUtcIsoDateTimeExpression(quotedColumnName);

    default:
      return `COALESCE(public.unaccent_immutable(${quotedColumnName}), '')`;
  }
};

// PostgreSQL's date/timestamptz text output is DateStyle/TimeZone dependent and
// therefore unsuitable in a stored generated column. Build ISO tokens only
// from immutable timestamp/date-part operations instead.
const getIsoDateExpression = (quotedColumnName: string): string =>
  `CASE WHEN ${quotedColumnName} IS NULL THEN '' ELSE ` +
  `lpad(EXTRACT(YEAR FROM ${quotedColumnName})::integer::text, 4, '0') || '-' || ` +
  `lpad(EXTRACT(MONTH FROM ${quotedColumnName})::integer::text, 2, '0') || '-' || ` +
  `lpad(EXTRACT(DAY FROM ${quotedColumnName})::integer::text, 2, '0') END`;

const getUtcIsoDateTimeExpression = (quotedColumnName: string): string => {
  const utcTimestamp = `timezone('UTC', ${quotedColumnName})`;
  const secondsMicros = `round(EXTRACT(SECOND FROM ${utcTimestamp}) * 1000000)::bigint`;

  return (
    `CASE WHEN ${quotedColumnName} IS NULL THEN '' ELSE ` +
    `lpad(EXTRACT(YEAR FROM ${utcTimestamp})::integer::text, 4, '0') || '-' || ` +
    `lpad(EXTRACT(MONTH FROM ${utcTimestamp})::integer::text, 2, '0') || '-' || ` +
    `lpad(EXTRACT(DAY FROM ${utcTimestamp})::integer::text, 2, '0') || 'T' || ` +
    `lpad(EXTRACT(HOUR FROM ${utcTimestamp})::integer::text, 2, '0') || ':' || ` +
    `lpad(EXTRACT(MINUTE FROM ${utcTimestamp})::integer::text, 2, '0') || ':' || ` +
    `lpad((${secondsMicros} / 1000000)::text, 2, '0') || '.' || ` +
    `lpad((${secondsMicros} % 1000000)::text, 6, '0') || 'Z' END`
  );
};
