import { STANDARD_OBJECTS } from 'twenty-shared/metadata';
import { type QueryRunner } from 'typeorm';

import { type FlatObjectMetadata } from 'src/engine/metadata-modules/flat-object-metadata/types/flat-object-metadata.type';
import { getWorkspaceSchemaContextForMigration } from 'src/engine/workspace-manager/workspace-migration/workspace-migration-runner/utils/get-workspace-schema-context-for-migration.util';
import { escapeIdentifier } from 'src/engine/workspace-manager/workspace-migration/utils/remove-sql-injection.util';

export const PARTICIPANT_HANDLE_INDEXES = [
  {
    universalIdentifier:
      STANDARD_OBJECTS.messageParticipant.universalIdentifier,
    indexName: 'IDX_MESSAGE_PARTICIPANT_NORMALIZED_HANDLE',
  },
  {
    universalIdentifier:
      STANDARD_OBJECTS.calendarEventParticipant.universalIdentifier,
    indexName: 'IDX_CALENDAR_EVENT_PARTICIPANT_NORMALIZED_HANDLE',
  },
];

// Expression indexes cannot be represented by IndexMetadata's field-only columns.
// The standard-object create handler and workspace upgrade own these physical indexes.
export const ensureParticipantHandleIndex = async ({
  queryRunner,
  workspaceId,
  objectMetadata,
  dryRun = false,
}: {
  queryRunner: QueryRunner;
  workspaceId: string;
  objectMetadata: FlatObjectMetadata;
  dryRun?: boolean;
}): Promise<void> => {
  const target = PARTICIPANT_HANDLE_INDEXES.find(
    ({ universalIdentifier }) =>
      universalIdentifier === objectMetadata.universalIdentifier,
  );

  if (!target || objectMetadata.isCustom) {
    return;
  }

  const { schemaName, tableName } = getWorkspaceSchemaContextForMigration({
    workspaceId,
    objectMetadata,
  });
  const existing: {
    tableName: string;
    isUnique: boolean;
    isValid: boolean;
    expression: string;
    predicate: string | null;
    keyCount: number;
  }[] = await queryRunner.query(
    `SELECT t.relname AS "tableName", i.indisunique AS "isUnique",
            i.indisvalid AS "isValid", pg_get_expr(i.indexprs, i.indrelid) AS expression,
            pg_get_expr(i.indpred, i.indrelid) AS predicate, i.indnkeyatts AS "keyCount"
     FROM pg_index i
     JOIN pg_class c ON c.oid = i.indexrelid
     JOIN pg_class t ON t.oid = i.indrelid
     JOIN pg_namespace n ON n.oid = c.relnamespace
     WHERE n.nspname = $1 AND c.relname = $2`,
    [schemaName, target.indexName],
  );

  if (existing.length > 0) {
    const index = existing[0];

    if (
      index.tableName !== tableName ||
      index.isUnique ||
      !index.isValid ||
      index.expression !== 'lower(TRIM(BOTH FROM handle))' ||
      index.predicate !== null ||
      index.keyCount !== 1
    ) {
      throw new Error(
        `Conflicting participant handle index ${schemaName}.${target.indexName}`,
      );
    }

    return;
  }

  if (!dryRun) {
    await queryRunner.query(
      `CREATE INDEX ${escapeIdentifier(target.indexName)} ON ${escapeIdentifier(schemaName)}.${escapeIdentifier(tableName)} (LOWER(TRIM("handle")))`,
    );
  }
};
