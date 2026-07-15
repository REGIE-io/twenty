import { CallWebhookJobsJob } from 'src/engine/metadata-modules/webhook/jobs/call-webhook-jobs.job';

describe('CallWebhookJobsJob', () => {
  it('does not fan out queued record webhooks when webhooks are disabled', async () => {
    const messageQueueService = { add: jest.fn() };
    const workspaceCacheService = { getOrRecompute: jest.fn() };
    const twentyConfigService = {
      get: jest.fn().mockReturnValue(false),
    };

    const job = new (CallWebhookJobsJob as any)(
      messageQueueService,
      workspaceCacheService,
      twentyConfigService,
    );

    await job.handle({
      name: 'person.created',
      workspaceId: 'workspace-id',
      objectMetadata: {
        id: 'person-object-id',
        nameSingular: 'person',
      },
      events: [],
    } as any);

    expect(workspaceCacheService.getOrRecompute).not.toHaveBeenCalled();
    expect(messageQueueService.add).not.toHaveBeenCalled();
  });
});
