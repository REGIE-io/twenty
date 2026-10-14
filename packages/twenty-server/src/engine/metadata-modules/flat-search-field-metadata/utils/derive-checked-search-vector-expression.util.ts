import { STANDARD_OBJECTS } from 'twenty-shared/metadata';
import { isDefined } from 'twenty-shared/utils';

import { type FlatFieldMetadata } from 'src/engine/metadata-modules/flat-field-metadata/types/flat-field-metadata.type';
import { type FlatObjectMetadata } from 'src/engine/metadata-modules/flat-object-metadata/types/flat-object-metadata.type';
import { type FlatSearchFieldMetadata } from 'src/engine/metadata-modules/flat-search-field-metadata/types/flat-search-field-metadata.type';
import { type SearchVectorExpressionShape } from 'src/engine/metadata-modules/flat-search-field-metadata/utils/compute-search-vector-as-expression-from-search-field-metadatas.util';
import { deriveSearchVectorAsExpressionForTsVectorField } from 'src/engine/metadata-modules/flat-search-field-metadata/utils/derive-search-vector-as-expression-for-ts-vector-field.util';
import { belongsToTwentyStandardApp } from 'src/engine/metadata-modules/utils/belongs-to-twenty-standard-app.util';
import { SEARCH_FIELDS_BY_STANDARD_OBJECT_NAME } from 'src/engine/workspace-manager/twenty-standard-application/constants/search-fields-by-standard-object-name.constant';
import {
  WorkspaceMigrationActionExecutionException,
  WorkspaceMigrationActionExecutionExceptionCode,
} from 'src/engine/workspace-manager/workspace-migration/workspace-migration-runner/exceptions/workspace-migration-action-execution.exception';

type StandardObjectName = keyof typeof SEARCH_FIELDS_BY_STANDARD_OBJECT_NAME;

// Only fields the workspace actually has, and has active, are expected: an upgrade can
// add a standard field to the list before the step that creates the field has run.
const findMissingStandardSearchFieldNames = ({
  flatObjectMetadata,
  objectFlatFieldMetadatas,
  targetSearchFieldMetadatas,
}: {
  flatObjectMetadata: FlatObjectMetadata;
  objectFlatFieldMetadatas: FlatFieldMetadata[];
  targetSearchFieldMetadatas: FlatSearchFieldMetadata[];
}): string[] => {
  if (!belongsToTwentyStandardApp(flatObjectMetadata)) {
    return [];
  }

  const objectName = (
    Object.keys(SEARCH_FIELDS_BY_STANDARD_OBJECT_NAME) as StandardObjectName[]
  ).find(
    (standardObjectName) =>
      STANDARD_OBJECTS[standardObjectName].universalIdentifier ===
      flatObjectMetadata.universalIdentifier,
  );

  if (!isDefined(objectName)) {
    return [];
  }

  const activeFieldUniversalIdentifiers = new Set(
    objectFlatFieldMetadatas
      .filter((flatFieldMetadata) => flatFieldMetadata.isActive)
      .map((flatFieldMetadata) => flatFieldMetadata.universalIdentifier),
  );
  const searchedFieldUniversalIdentifiers = new Set(
    targetSearchFieldMetadatas.map(
      (searchFieldMetadata) =>
        searchFieldMetadata.fieldMetadataUniversalIdentifier,
    ),
  );
  const standardFields: Record<string, { universalIdentifier: string }> =
    STANDARD_OBJECTS[objectName].fields;

  return SEARCH_FIELDS_BY_STANDARD_OBJECT_NAME[objectName].flatMap(
    ({ name }) => {
      const fieldUniversalIdentifier =
        standardFields[name]?.universalIdentifier;

      if (
        !isDefined(fieldUniversalIdentifier) ||
        !activeFieldUniversalIdentifiers.has(fieldUniversalIdentifier) ||
        searchedFieldUniversalIdentifiers.has(fieldUniversalIdentifier)
      ) {
        return [];
      }

      return [name];
    },
  );
};

// Shared by the migration runner and the trigger conversion so both build the formula
// from the same fields. GO-660: an empty or custom-only list silently built a formula that
// indexed nothing, so a missing standard field fails the migration instead.
// isNewTable skips that check: a table being created has no rows to lose, and an upgrade
// can create a standard object before the later step that adds its search rows.
export const deriveCheckedSearchVectorExpression = ({
  flatObjectMetadata,
  objectFlatFieldMetadatas,
  targetSearchFieldMetadatas,
  shape,
  isNewTable = false,
}: {
  flatObjectMetadata: FlatObjectMetadata;
  objectFlatFieldMetadatas: FlatFieldMetadata[];
  targetSearchFieldMetadatas: FlatSearchFieldMetadata[];
  shape?: SearchVectorExpressionShape;
  isNewTable?: boolean;
}): string => {
  const missingFieldNames = isNewTable
    ? []
    : findMissingStandardSearchFieldNames({
        flatObjectMetadata,
        objectFlatFieldMetadatas,
        targetSearchFieldMetadatas,
      });

  if (missingFieldNames.length > 0) {
    throw new WorkspaceMigrationActionExecutionException({
      message: `Refusing to build searchVector for ${flatObjectMetadata.nameSingular}: standard search fields missing from searchFieldMetadata: ${missingFieldNames.join(', ')}`,
      code: WorkspaceMigrationActionExecutionExceptionCode.MISSING_STANDARD_SEARCH_FIELDS,
    });
  }

  const indexedFieldById = new Map(
    objectFlatFieldMetadatas.map((flatFieldMetadata) => [
      flatFieldMetadata.id,
      {
        name: flatFieldMetadata.name,
        type: flatFieldMetadata.type,
        options: flatFieldMetadata.options ?? undefined,
      },
    ]),
  );

  return deriveSearchVectorAsExpressionForTsVectorField({
    targetSearchFieldMetadatas,
    indexedFieldById,
    shape,
  });
};
