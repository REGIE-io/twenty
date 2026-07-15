import { MetadataEventsToDbListener } from 'src/engine/subscriptions/metadata-event/metadata-events-to-db.listener';
import { type MetadataEventBatch } from 'src/engine/subscriptions/metadata-event/types/metadata-event-batch.type';

describe('MetadataEventsToDbListener', () => {
  it('does not enqueue metadata webhooks when webhooks are disabled', async () => {
    const webhookQueueService = { add: jest.fn() };
    const metadataEventPublisher = { publish: jest.fn() };
    const workspaceCacheService = { getCacheHashes: jest.fn() };
    const twentyConfigService = {
      get: jest.fn().mockReturnValue(false),
    };

    const listener = new (MetadataEventsToDbListener as any)(
      webhookQueueService,
      metadataEventPublisher,
      workspaceCacheService,
      twentyConfigService,
    );

    await listener.handleCreate({
      name: 'metadata.objectMetadata.created',
      workspaceId: 'workspace-id',
      metadataName: 'objectMetadata',
      type: 'created',
      events: [],
    } as MetadataEventBatch<'objectMetadata', 'created'>);

    expect(webhookQueueService.add).not.toHaveBeenCalled();
  });
});
