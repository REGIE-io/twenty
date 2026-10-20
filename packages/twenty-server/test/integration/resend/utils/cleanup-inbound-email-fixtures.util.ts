import { getWorkspaceSchemaName } from 'src/engine/workspace-datasource/utils/get-workspace-schema-name.util';
import { SEED_APPLE_WORKSPACE_ID } from 'src/engine/workspace-manager/dev-seeder/core/constants/seeder-workspaces.constant';

export const cleanupInboundEmailFixtures = async ({
  headerMessageIds,
  messageThreadIds = [],
}: {
  headerMessageIds: string[];
  messageThreadIds?: string[];
}) => {
  const schema = getWorkspaceSchemaName(SEED_APPLE_WORKSPACE_ID);

  await globalThis.testDataSource.transaction(async (manager) => {
    const messages: { id: string; messageThreadId: string | null }[] =
      await manager.query(
        `SELECT id, "messageThreadId" FROM "${schema}"."message"
         WHERE "headerMessageId" = ANY($1::text[])
            OR "messageThreadId" = ANY($2::uuid[])`,
        [headerMessageIds, messageThreadIds],
      );
    const messageIds = messages.map(({ id }) => id);
    const threadIds = [
      ...new Set([
        ...messageThreadIds,
        ...messages.flatMap(({ messageThreadId }) =>
          messageThreadId === null ? [] : [messageThreadId],
        ),
      ]),
    ];

    await manager.query(
      `DELETE FROM "${schema}"."messageChannelMessageAssociationMessageFolder"
       WHERE "messageChannelMessageAssociationId" IN (
         SELECT id FROM "${schema}"."messageChannelMessageAssociation"
         WHERE "messageId" = ANY($1::uuid[]))`,
      [messageIds],
    );
    for (const table of [
      'messageChannelMessageAssociation',
      'messageParticipant',
    ]) {
      await manager.query(
        `DELETE FROM "${schema}"."${table}" WHERE "messageId" = ANY($1::uuid[])`,
        [messageIds],
      );
    }
    await manager.query(
      `DELETE FROM "${schema}"."message" WHERE id = ANY($1::uuid[])`,
      [messageIds],
    );

    // Do not remove a thread if it still contains a message from another fixture.
    const emptyThreads: { id: string }[] = await manager.query(
      `SELECT id FROM "${schema}"."messageThread" AS thread
       WHERE id = ANY($1::uuid[]) AND NOT EXISTS (
         SELECT 1 FROM "${schema}"."message"
         WHERE "messageThreadId" = thread.id)`,
      [threadIds],
    );
    const emptyThreadIds = emptyThreads.map(({ id }) => id);

    await manager.query(
      `DELETE FROM "${schema}"."messageThreadTarget"
       WHERE "messageThreadId" = ANY($1::uuid[])`,
      [emptyThreadIds],
    );
    await manager.query(
      `DELETE FROM "${schema}"."messageThread" WHERE id = ANY($1::uuid[])`,
      [emptyThreadIds],
    );
  });
};
