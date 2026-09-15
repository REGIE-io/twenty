import { MessageDirection } from 'src/modules/messaging/common/enums/message-direction.enum';
import { CallMessageReceivedWebhookJob } from 'src/modules/messaging/message-import-manager/jobs/call-message-received-webhook.job';
import { type CallMessageSyncWebhookJobData } from 'src/modules/messaging/message-import-manager/types/message-received-webhook-payload.type';
import {
  type DispatchSyncedMessageWebhooksInput,
  MessagingReplyWebhookDispatchService,
} from 'src/modules/messaging/message-import-manager/services/messaging-reply-webhook-dispatch.service';

const WORKSPACE_ID = 'workspace-1';

const baseInput = (
  overrides: Partial<DispatchSyncedMessageWebhooksInput> = {},
): DispatchSyncedMessageWebhooksInput => ({
  workspaceId: WORKSPACE_ID,
  channelId: 'channel-1',
  connectedAccountId: 'account-1',
  handle: 'rep@example.com',
  messages: [
    {
      messageId: 'message-1',
      messageExternalId: 'gmail-1',
      headerMessageId: '<CAE62F0v9DT3@mail.gmail.com>',
      threadId: 'thread-1',
      to: ['prospect@acme.com'],
      direction: MessageDirection.INCOMING,
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

    await service.dispatchSyncedMessageWebhooks(baseInput({ messages: [] }));

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

    await service.dispatchSyncedMessageWebhooks(baseInput());

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
          headerMessageId: '<CAE62F0v9DT3@mail.gmail.com>',
          threadId: 'thread-1',
          channelId: 'channel-1',
          connectedAccountId: 'account-1',
          handle: 'rep@example.com',
          to: ['prospect@acme.com'],
          direction: 'INCOMING',
          receivedAt: '2026-09-04T11:13:33.000Z',
        },
      },
      { retryLimit: 3 },
    );
  });

  it('emits message.sent for an outgoing message', async () => {
    const { service, messageQueueService } = makeHarness([
      {
        id: 'webhook-1',
        targetUrl: 'https://go.regie.ai/hooks/sent',
        secret: 'shh',
        operations: ['message.sent'],
      },
    ]);

    await service.dispatchSyncedMessageWebhooks(
      baseInput({
        messages: [
          {
            messageId: 'message-2',
            messageExternalId: 'gmail-2',
            headerMessageId: '<CAE62F0uZ0w@mail.gmail.com>',
            threadId: 'thread-2',
            to: ['prospect@acme.com', 'cto@acme.com'],
            direction: MessageDirection.OUTGOING,
            receivedAt: null,
          },
        ],
      }),
    );

    expect(messageQueueService.add).toHaveBeenCalledTimes(1);
    const jobData = (messageQueueService.add as jest.Mock).mock
      .calls[0][1] as CallMessageSyncWebhookJobData;

    expect(jobData.payload.eventName).toBe('message.sent');
    expect(jobData.payload.direction).toBe('OUTGOING');
    expect(jobData.payload.headerMessageId).toBe(
      '<CAE62F0uZ0w@mail.gmail.com>',
    );
    expect(jobData.payload.to).toEqual(['prospect@acme.com', 'cto@acme.com']);
  });

  it('does not send outgoing messages to a webhook subscribed only to message.received', async () => {
    const { service, messageQueueService } = makeHarness([
      {
        id: 'webhook-1',
        targetUrl: 'https://x',
        secret: 's',
        operations: ['message.received'],
      },
    ]);

    await service.dispatchSyncedMessageWebhooks(
      baseInput({
        messages: [
          {
            messageId: 'message-2',
            messageExternalId: 'gmail-2',
            headerMessageId: null,
            threadId: null,
            to: [],
            direction: MessageDirection.OUTGOING,
            receivedAt: null,
          },
        ],
      }),
    );

    expect(messageQueueService.add).not.toHaveBeenCalled();
  });

  it('matches wildcard operations', async () => {
    const { service, messageQueueService } = makeHarness([
      { id: 'w', targetUrl: 'https://x', secret: 's', operations: ['*.*'] },
    ]);

    await service.dispatchSyncedMessageWebhooks(baseInput());

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

    await service.dispatchSyncedMessageWebhooks(baseInput());

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

    await service.dispatchSyncedMessageWebhooks(
      baseInput({
        messages: [
          {
            messageId: 'm1',
            messageExternalId: 'e1',
            headerMessageId: '<a@mail.gmail.com>',
            threadId: 't1',
            to: ['a@acme.com'],
            direction: MessageDirection.INCOMING,
            receivedAt: null,
          },
          {
            messageId: 'm2',
            messageExternalId: 'e2',
            headerMessageId: null,
            threadId: null,
            to: [],
            direction: MessageDirection.INCOMING,
            receivedAt: null,
          },
        ],
      }),
    );

    expect(messageQueueService.add).toHaveBeenCalledTimes(4);
    const firstJobData = (messageQueueService.add as jest.Mock).mock
      .calls[0][1] as CallMessageSyncWebhookJobData;

    expect(firstJobData.payload.receivedAt).toBeNull();
  });
});
