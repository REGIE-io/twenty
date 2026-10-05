import { isDefined } from 'twenty-shared/utils';
import { type QueryRunner } from 'typeorm';

import {
  buildSearchVectorTriggerStatements,
  getSearchVectorFunctionName,
  type SearchVectorTriggerStatements,
} from 'src/engine/core-modules/search-vector-trigger/utils/build-search-vector-trigger-statements.util';
import {
  getSearchVectorColumnState,
  hasSearchVectorTrigger,
} from 'src/engine/core-modules/search-vector-trigger/utils/search-vector-table-queries.util';
import { type FlatEntityMaps } from 'src/engine/metadata-modules/flat-entity/types/flat-entity-maps.type';
import { findManyFlatEntityByIdInFlatEntityMaps } from 'src/engine/metadata-modules/flat-entity/utils/find-many-flat-entity-by-id-in-flat-entity-maps.util';
import { type FlatFieldMetadata } from 'src/engine/metadata-modules/flat-field-metadata/types/flat-field-metadata.type';
import { type FlatObjectMetadata } from 'src/engine/metadata-modules/flat-object-metadata/types/flat-object-metadata.type';
import { type FlatSearchFieldMetadata } from 'src/engine/metadata-modules/flat-search-field-metadata/types/flat-search-field-metadata.type';
import { deriveCheckedSearchVectorExpression } from 'src/engine/metadata-modules/flat-search-field-metadata/utils/derive-checked-search-vector-expression.util';
import { findTsVectorFlatFieldMetadataForObject } from 'src/engine/metadata-modules/flat-search-field-metadata/utils/find-ts-vector-flat-field-metadata-for-object.util';
import { getTargetSearchFieldMetadatasForTsVectorField } from 'src/engine/metadata-modules/flat-search-field-metadata/utils/get-target-search-field-metadatas-for-ts-vector-field.util';
import { escapeIdentifier } from 'src/engine/workspace-manager/workspace-migration/utils/remove-sql-injection.util';

type SearchVectorTable = {
  schemaName: string;
  tableName: string;
};

// Everything needed to rebuild a table's trigger function from its current fields.
export type SearchVectorTriggerSource = SearchVectorTable & {
  queryRunner: QueryRunner;
  flatObjectMetadata: FlatObjectMetadata;
  objectFlatFieldMetadatas: FlatFieldMetadata[];
  targetSearchFieldMetadatas: FlatSearchFieldMetadata[];
};

const qualifyName = (schemaName: string, name: string): string =>
  `${escapeIdentifier(schemaName)}.${escapeIdentifier(name)}`;

export const installSearchVectorTrigger = async ({
  queryRunner,
  qualifiedTable,
  statements,
  triggerRowExpression,
  skipCreateFunction = false,
}: {
  queryRunner: QueryRunner;
  qualifiedTable: string;
  statements: SearchVectorTriggerStatements;
  triggerRowExpression: string;
  skipCreateFunction?: boolean;
}): Promise<void> => {
  if (!skipCreateFunction) {
    await queryRunner.query(statements.createFunction);
  }
  await queryRunner.query(statements.dropTrigger);
  await queryRunner.query(statements.createTrigger);
  // Parse-check under the function's search_path, as plpgsql would only fail at the first write.
  // SET LOCAL lasts the whole transaction, so the caller's search_path is restored after.
  const [{ search_path: previousSearchPath }] = await queryRunner.query(
    `SELECT current_setting('search_path') AS search_path`,
  );

  await queryRunner.query(`SET LOCAL search_path = pg_catalog, public`);
  await queryRunner.query(
    `SELECT ${triggerRowExpression} FROM ${qualifiedTable} AS new LIMIT 0`,
  );
  await queryRunner.query(`SELECT set_config('search_path', $1, true)`, [
    previousSearchPath,
  ]);
  // Runtime check, so a broken expression rolls back instead of failing every later write. It fires
  // every trigger on the row (e.g. person's phone lookup); acceptable as only converted tables get here.
  await queryRunner.query(
    `UPDATE ${qualifiedTable} SET "id" = "id" WHERE "id" = (SELECT "id" FROM ${qualifiedTable} LIMIT 1)`,
  );
};

// Read from the catalog, never from a flag, so each table follows its own real state.
export const isSearchVectorTriggerMode = async (
  queryRunner: QueryRunner,
  { schemaName, tableName }: SearchVectorTable,
): Promise<boolean> => {
  const columnState = await getSearchVectorColumnState(
    queryRunner,
    schemaName,
    tableName,
  );

  if (columnState !== 'plain') {
    return false;
  }

  const functionName = getSearchVectorFunctionName(tableName);

  return hasSearchVectorTrigger(queryRunner, {
    qualifiedTable: qualifyName(schemaName, tableName),
    triggerName: functionName,
    qualifiedFunction: qualifyName(schemaName, functionName),
  });
};

export const reinstallSearchVectorTrigger = async ({
  queryRunner,
  schemaName,
  tableName,
  flatObjectMetadata,
  objectFlatFieldMetadatas,
  targetSearchFieldMetadatas,
}: SearchVectorTriggerSource): Promise<void> => {
  const triggerRowExpression = deriveCheckedSearchVectorExpression({
    flatObjectMetadata,
    objectFlatFieldMetadatas,
    targetSearchFieldMetadatas,
    shape: 'triggerRow',
  });

  await installSearchVectorTrigger({
    queryRunner,
    qualifiedTable: qualifyName(schemaName, tableName),
    statements: buildSearchVectorTriggerStatements({
      schemaName,
      tableName,
      triggerRowExpression,
    }),
    triggerRowExpression,
  });
};

// The single entry point for keeping a converted table's function in step with its fields.
export const refreshSearchVectorTriggerIfConverted = async (
  source: SearchVectorTriggerSource,
): Promise<boolean> => {
  if (!(await isSearchVectorTriggerMode(source.queryRunner, source))) {
    return false;
  }

  await reinstallSearchVectorTrigger(source);

  return true;
};

// Builds the field list as it is after the current action: the changed field replaces its
// stored version, and a deleted field is left out.
export const findSearchVectorTriggerSource = ({
  queryRunner,
  schemaName,
  tableName,
  flatObjectMetadata,
  flatFieldMetadataMaps,
  flatSearchFieldMetadataMaps,
  getSearchFieldMetadatasByTsVectorFieldId,
  updatedFlatFieldMetadata,
  deletedFieldMetadataId,
}: SearchVectorTable & {
  queryRunner: QueryRunner;
  flatObjectMetadata: FlatObjectMetadata;
  flatFieldMetadataMaps: FlatEntityMaps<FlatFieldMetadata>;
  flatSearchFieldMetadataMaps: FlatEntityMaps<FlatSearchFieldMetadata>;
  getSearchFieldMetadatasByTsVectorFieldId?: (
    tsVectorFieldMetadataId: string,
  ) => FlatSearchFieldMetadata[];
  updatedFlatFieldMetadata?: FlatFieldMetadata;
  deletedFieldMetadataId?: string;
}): SearchVectorTriggerSource | undefined => {
  const tsVectorFlatFieldMetadata = findTsVectorFlatFieldMetadataForObject({
    fieldUniversalIdentifiers: flatObjectMetadata.fieldUniversalIdentifiers,
    flatFieldMetadataMaps,
  });

  if (!isDefined(tsVectorFlatFieldMetadata)) {
    return undefined;
  }

  const objectFlatFieldMetadatas = findManyFlatEntityByIdInFlatEntityMaps({
    flatEntityMaps: flatFieldMetadataMaps,
    flatEntityIds: flatObjectMetadata.fieldIds,
  })
    .filter(
      (flatFieldMetadata) => flatFieldMetadata.id !== deletedFieldMetadataId,
    )
    .map((flatFieldMetadata) =>
      flatFieldMetadata.id === updatedFlatFieldMetadata?.id
        ? updatedFlatFieldMetadata
        : flatFieldMetadata,
    );

  const targetSearchFieldMetadatas =
    getSearchFieldMetadatasByTsVectorFieldId?.(tsVectorFlatFieldMetadata.id) ??
    getTargetSearchFieldMetadatasForTsVectorField({
      tsVectorFieldMetadataId: tsVectorFlatFieldMetadata.id,
      flatSearchFieldMetadataMaps,
    });

  return {
    queryRunner,
    schemaName,
    tableName,
    flatObjectMetadata,
    objectFlatFieldMetadatas,
    targetSearchFieldMetadatas,
  };
};

export const disableSearchVectorTrigger = async (
  queryRunner: QueryRunner,
  { schemaName, tableName }: SearchVectorTable,
): Promise<void> => {
  await queryRunner.query(
    `ALTER TABLE ${qualifyName(schemaName, tableName)} DISABLE TRIGGER ${escapeIdentifier(getSearchVectorFunctionName(tableName))}`,
  );
};

// DROP TABLE takes the trigger with it but leaves the function behind.
export const dropSearchVectorFunction = async (
  queryRunner: QueryRunner,
  { schemaName, tableName }: SearchVectorTable,
): Promise<void> => {
  await queryRunner.query(
    `DROP FUNCTION IF EXISTS ${qualifyName(schemaName, getSearchVectorFunctionName(tableName))}()`,
  );
};

// Dropping the searchVector column leaves a trigger that would assign to it on every write.
export const dropSearchVectorTrigger = async (
  queryRunner: QueryRunner,
  { schemaName, tableName }: SearchVectorTable,
): Promise<void> => {
  await queryRunner.query(
    `DROP TRIGGER IF EXISTS ${escapeIdentifier(getSearchVectorFunctionName(tableName))} ON ${qualifyName(schemaName, tableName)}`,
  );
  await dropSearchVectorFunction(queryRunner, { schemaName, tableName });
};

// Run after the table rename, so detection on the new table name keeps finding the trigger.
export const renameSearchVectorTrigger = async (
  queryRunner: QueryRunner,
  {
    schemaName,
    fromTableName,
    toTableName,
  }: { schemaName: string; fromTableName: string; toTableName: string },
): Promise<void> => {
  const fromName = getSearchVectorFunctionName(fromTableName);
  const toName = getSearchVectorFunctionName(toTableName);

  await queryRunner.query(
    `ALTER TRIGGER ${escapeIdentifier(fromName)} ON ${qualifyName(schemaName, toTableName)} RENAME TO ${escapeIdentifier(toName)}`,
  );
  // A function left by an earlier table of this name would block the rename; nothing uses it.
  await dropSearchVectorFunction(queryRunner, {
    schemaName,
    tableName: toTableName,
  });
  await queryRunner.query(
    `ALTER FUNCTION ${qualifyName(schemaName, fromName)}() RENAME TO ${escapeIdentifier(toName)}`,
  );
};
