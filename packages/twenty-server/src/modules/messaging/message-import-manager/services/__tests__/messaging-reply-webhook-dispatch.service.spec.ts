import { CallMessageReceivedWebhookJob } from 'src/modules/messaging/message-import-manager/jobs/call-message-received-webhook.job';
import { type CallMessageReceivedWebhookJobData } from 'src/modules/messaging/message-import-manager/types/message-received-webhook-payload.type';
import {
  type DispatchIncomingMessageWebhooksInput,
  MessagingReplyWebhookDispatchService,
} from 'src/modules/messaging/message-import-manager/services/messaging-reply-webhook-dispatch.service';

const WORKSPACE_ID = 'workspace-1';

const baseInput = (
  overrides: Partial<DispatchIncomingMessageWebhooksInput> = {},
): DispatchIncomingMessageWebhooksInput => ({
  workspaceId: WORKSPACE_ID,
  channelId: 'channel-1',
  connectedAccountId: 'account-1',
  handle: 'rep@example.com',
  messages: [
    {
      messageId: 'message-1',
      messageExternalId: 'gmail-1',
      threadId: 'thread-1',
      receivedAt: new Date('2026-09-04T11:13:33.000Z'),
    },
  ],
  ...overrides,
});

const makeHarness = (webhooks: unknown[]) => {
  const webhookRepository = {
    find: jest.fn(async () => webhooks),
  };
  const messageQueueService = {
    add: jest.fn(async () => undefined),
  };
  const service = new MessagingReplyWebhookDispatchService(
    webhookRepository as never,
    messageQueueService as never,
  );

  return { service, webhookRepository, messageQueueService };
};

describe('MessagingReplyWebhookDispatchService', () => {
  it('does nothing when there are no messages', async () => {
    const { service, webhookRepository, messageQueueService } = makeHarness([]);

    await service.dispatchIncomingMessageWebhooks(baseInput({ messages: [] }));

    expect(webhookRepository.find).not.toHaveBeenCalled();
    expect(messageQueueService.add).not.toHaveBeenCalled();
  });

  it('enqueues a signed job with a thin payload for a matching webhook', async () => {
    const { service, messageQueueService } = makeHarness([
      {
        id: 'webhook-1',
        targetUrl: 'https://go.regie.ai/hooks/replies',
        secret: 'shh',
        operations: ['message.received'],
      },
    ]);

    await service.dispatchIncomingMessageWebhooks(baseInput());

    expect(messageQueueService.add).toHaveBeenCalledTimes(1);
    expect(messageQueueService.add).toHaveBeenCalledWith(
      CallMessageReceivedWebhookJob.name,
      {
        targetUrl: 'https://go.regie.ai/hooks/replies',
        secret: 'shh',
        webhookId: 'webhook-1',
        workspaceId: WORKSPACE_ID,
        payload: {
          eventName: 'message.received',
          webhookId: 'webhook-1',
          workspaceId: WORKSPACE_ID,
          messageId: 'message-1',
          messageExternalId: 'gmail-1',
          threadId: 'thread-1',
          channelId: 'channel-1',
          connectedAccountId: 'account-1',
          handle: 'rep@example.com',
          direction: 'INCOMING',
          receivedAt: '2026-09-04T11:13:33.000Z',
        },
      },
      { retryLimit: 3 },
    );
  });

  it('matches wildcard operations', async () => {
    const { service, messageQueueService } = makeHarness([
      { id: 'w', targetUrl: 'https://x', secret: 's', operations: ['*.*'] },
    ]);

    await service.dispatchIncomingMessageWebhooks(baseInput());

    expect(messageQueueService.add).toHaveBeenCalledTimes(1);
  });

  it('ignores a webhook subscribed to unrelated operations', async () => {
    const { service, messageQueueService } = makeHarness([
      {
        id: 'w',
        targetUrl: 'https://x',
        secret: 's',
        operations: ['person.created', 'company.updated'],
      },
    ]);

    await service.dispatchIncomingMessageWebhooks(baseInput());

    expect(messageQueueService.add).not.toHaveBeenCalled();
  });

  it('fans out one job per webhook per message and tolerates a null receivedAt', async () => {
    const { service, messageQueueService } = makeHarness([
      {
        id: 'w1',
        targetUrl: 'https://a',
        secret: 's',
        operations: ['message.*'],
      },
      {
        id: 'w2',
        targetUrl: 'https://b',
        secret: 's',
        operations: ['*.received'],
      },
    ]);

    await service.dispatchIncomingMessageWebhooks(
      baseInput({
        messages: [
          {
            messageId: 'm1',
            messageExternalId: 'e1',
            threadId: 't1',
            receivedAt: null,
          },
          {
            messageId: 'm2',
            messageExternalId: 'e2',
            threadId: null,
            receivedAt: null,
          },
        ],
      }),
    );

    expect(messageQueueService.add).toHaveBeenCalledTimes(4);
    const firstJobData = (messageQueueService.add as jest.Mock).mock
      .calls[0][1] as CallMessageReceivedWebhookJobData;

    expect(firstJobData.payload.receivedAt).toBeNull();
  });
});
