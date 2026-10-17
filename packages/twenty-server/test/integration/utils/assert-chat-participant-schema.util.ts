import { type DataSource } from 'typeorm';

import { getWorkspaceSchemaName } from 'src/engine/workspace-datasource/utils/get-workspace-schema-name.util';

export const assertChatParticipantSchema = async (
  dataSource: DataSource,
  workspaceId: string,
): Promise<void> => {
  const [schema]: {
    hasObjectMetadata: boolean;
    fields: string[];
    columns: string[];
  }[] = await dataSource.query(
    `SELECT EXISTS (
       SELECT 1 FROM core."objectMetadata"
       WHERE "workspaceId" = $1 AND "nameSingular" = 'agentChatThreadParticipant'
     ) AS "hasObjectMetadata",
     ARRAY(
       SELECT field.name FROM core."fieldMetadata" field
       JOIN core."objectMetadata" object ON object.id = field."objectMetadataId"
       WHERE object."workspaceId" = $1 AND object."nameSingular" = 'agentChatThreadParticipant'
     ) AS fields,
     ARRAY(
       SELECT column_name FROM information_schema.columns
       WHERE table_schema = $2 AND table_name = 'agentChatThreadParticipant'
     ) AS columns`,
    [workspaceId, getWorkspaceSchemaName(workspaceId)],
  );
  const missingFields = [
    'thread',
    'workspaceMember',
    'isSubscribed',
    'lastMentionedAt',
    'lastReadAt',
    'archivedAt',
    'snoozedUntil',
  ].filter((field) => !schema.fields.includes(field));
  const missingColumns = [
    'id',
    'threadId',
    'workspaceMemberId',
    'isSubscribed',
    'lastMentionedAt',
    'lastReadAt',
    'archivedAt',
    'snoozedUntil',
  ].filter((column) => !schema.columns.includes(column));

  if (
    !schema.hasObjectMetadata ||
    missingFields.length > 0 ||
    missingColumns.length > 0
  ) {
    throw new Error(
      `Incomplete agentChatThreadParticipant schema for ${workspaceId}: object metadata=${schema.hasObjectMetadata}, missing fields=[${missingFields.join(', ')}], missing columns=[${missingColumns.join(', ')}]. Restore the current chat upgrades before running integration tests.`,
    );
  }
};
