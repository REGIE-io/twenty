import { CallWebhookJobsForMetadataJob } from 'src/engine/metadata-modules/webhook/jobs/call-webhook-jobs-for-metadata.job';

describe('CallWebhookJobsForMetadataJob', () => {
  it('does not fan out queued metadata webhooks when webhooks are disabled', async () => {
    const messageQueueService = { add: jest.fn() };
    const workspaceCacheService = { getOrRecompute: jest.fn() };
    const twentyConfigService = {
      get: jest.fn().mockReturnValue(false),
    };

    const job = new (CallWebhookJobsForMetadataJob as any)(
      messageQueueService,
      workspaceCacheService,
      twentyConfigService,
    );

    await job.handle({
      name: 'metadata.objectMetadata.created',
      workspaceId: 'workspace-id',
      metadataName: 'objectMetadata',
      type: 'created',
      events: [],
    });

    expect(workspaceCacheService.getOrRecompute).not.toHaveBeenCalled();
    expect(messageQueueService.add).not.toHaveBeenCalled();
  });
});
