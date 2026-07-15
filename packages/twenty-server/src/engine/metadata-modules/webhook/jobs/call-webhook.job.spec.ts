import { CallWebhookJob } from 'src/engine/metadata-modules/webhook/jobs/call-webhook.job';
import { type WebhookJobData } from 'src/engine/metadata-modules/webhook/types/webhook-job-data.type';

describe('CallWebhookJob', () => {
  it('does not deliver queued webhooks when webhooks are disabled', async () => {
    const eventLogEmitterService = {
      createContext: jest.fn().mockReturnValue({
        insertWorkspaceEvent: jest.fn(),
      }),
    };
    const metricsService = { incrementCounterForEvent: jest.fn() };
    const secureHttpClientService = {
      getHttpClient: jest.fn().mockReturnValue({
        post: jest.fn().mockResolvedValue({ status: 200 }),
      }),
    };
    const twentyConfigService = {
      get: jest.fn().mockReturnValue(false),
    };

    const job = new (CallWebhookJob as any)(
      eventLogEmitterService,
      metricsService,
      secureHttpClientService,
      twentyConfigService,
    );

    await job.handle([
      {
        targetUrl: 'https://example.com/webhook',
        eventName: 'person.created',
        workspaceId: 'workspace-id',
        webhookId: 'webhook-id',
        eventDate: new Date(),
        objectMetadata: {
          id: 'person-object-id',
          nameSingular: 'person',
        },
        record: { id: 'person-id' },
      } satisfies WebhookJobData,
    ]);

    expect(secureHttpClientService.getHttpClient).not.toHaveBeenCalled();
  });
});
