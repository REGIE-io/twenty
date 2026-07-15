import { type ObjectRecordCreateEvent } from 'twenty-shared/database-events';

import { EntityEventsToDbListener } from 'src/engine/api/graphql/workspace-query-runner/listeners/entity-events-to-db.listener';
import { type WorkspaceEventBatch } from 'src/engine/workspace-event-emitter/types/workspace-event-batch.type';

describe('EntityEventsToDbListener', () => {
  it('does not enqueue record webhooks when webhooks are disabled', async () => {
    const entityEventsToDbQueueService = { add: jest.fn() };
    const webhookQueueService = { add: jest.fn() };
    const triggerQueueService = { add: jest.fn() };
    const objectRecordEventPublisher = { publish: jest.fn() };
    const twentyConfigService = {
      get: jest.fn().mockReturnValue(false),
    };

    const listener = new (EntityEventsToDbListener as any)(
      entityEventsToDbQueueService,
      webhookQueueService,
      triggerQueueService,
      objectRecordEventPublisher,
      twentyConfigService,
    );

    await listener.handleCreate({
      name: 'person.created',
      workspaceId: 'workspace-id',
      objectMetadata: {
        id: 'person-object-id',
        nameSingular: 'person',
        universalIdentifier: 'person-universal-identifier',
        isAuditLogged: false,
      },
      events: [],
    } as unknown as WorkspaceEventBatch<ObjectRecordCreateEvent>);

    expect(webhookQueueService.add).not.toHaveBeenCalled();
    expect(triggerQueueService.add).toHaveBeenCalledTimes(1);
    expect(objectRecordEventPublisher.publish).toHaveBeenCalledTimes(1);
  });
});
