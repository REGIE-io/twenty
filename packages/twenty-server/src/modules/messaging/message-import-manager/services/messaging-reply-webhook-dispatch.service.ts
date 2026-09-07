import { Injectable, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';

import { isDefined } from 'twenty-shared/utils';
import { Repository } from 'typeorm';

import { InjectMessageQueue } from 'src/engine/core-modules/message-queue/decorators/message-queue.decorator';
import { MessageQueue } from 'src/engine/core-modules/message-queue/message-queue.constants';
import { MessageQueueService } from 'src/engine/core-modules/message-queue/services/message-queue.service';
import { WebhookEntity } from 'src/engine/metadata-modules/webhook/entities/webhook.entity';
import {
  MESSAGE_RECEIVED_WEBHOOK_EVENT,
  buildMessageReceivedWebhookOperationsToMatch,
} from 'src/modules/messaging/message-import-manager/constants/messaging-reply-webhook.constant';
import { CallMessageReceivedWebhookJob } from 'src/modules/messaging/message-import-manager/jobs/call-message-received-webhook.job';
import { type CallMessageReceivedWebhookJobData } from 'src/modules/messaging/message-import-manager/types/message-received-webhook-payload.type';

export type IncomingMessageForWebhook = {
  messageId: string;
  messageExternalId: string;
  threadId: string | null;
  receivedAt: Date | null;
};

export type DispatchIncomingMessageWebhooksInput = {
  workspaceId: string;
  channelId: string;
  connectedAccountId: string;
  handle: string;
  messages: IncomingMessageForWebhook[];
};

@Injectable()
export class MessagingReplyWebhookDispatchService {
  private readonly logger = new Logger(
    MessagingReplyWebhookDispatchService.name,
  );

  constructor(
    @InjectRepository(WebhookEntity)
    private readonly webhookRepository: Repository<WebhookEntity>,
    @InjectMessageQueue(MessageQueue.webhookQueue)
    private readonly messageQueueService: MessageQueueService,
  ) {}

  async dispatchIncomingMessageWebhooks(
    input: DispatchIncomingMessageWebhooksInput,
  ): Promise<void> {
    const { workspaceId, channelId, connectedAccountId, handle, messages } =
      input;

    if (messages.length === 0) {
      return;
    }

    const webhooks = await this.findMatchingWebhooks(workspaceId);

    if (webhooks.length === 0) {
      return;
    }

    // One job per webhook per message: the receiver dedupes on messageExternalId, and a
    // single failing endpoint retries without holding up the others.
    for (const webhook of webhooks) {
      for (const message of messages) {
        const jobData: CallMessageReceivedWebhookJobData = {
          targetUrl: webhook.targetUrl,
          secret: webhook.secret,
          webhookId: webhook.id,
          workspaceId,
          payload: {
            eventName: MESSAGE_RECEIVED_WEBHOOK_EVENT,
            webhookId: webhook.id,
            workspaceId,
            messageId: message.messageId,
            messageExternalId: message.messageExternalId,
            threadId: message.threadId,
            channelId,
            connectedAccountId,
            handle,
            direction: 'INCOMING',
            receivedAt: message.receivedAt?.toISOString() ?? null,
          },
        };

        await this.messageQueueService.add<CallMessageReceivedWebhookJobData>(
          CallMessageReceivedWebhookJob.name,
          jobData,
          { retryLimit: 3 },
        );
      }
    }

    this.logger.log(
      `Dispatched ${MESSAGE_RECEIVED_WEBHOOK_EVENT} for ${messages.length} message(s) to ${webhooks.length} webhook(s) in workspace ${workspaceId}`,
    );
  }

  private async findMatchingWebhooks(
    workspaceId: string,
  ): Promise<WebhookEntity[]> {
    const operationsToMatch = buildMessageReceivedWebhookOperationsToMatch();

    const webhooks = await this.webhookRepository.find({
      where: { workspaceId },
    });

    return webhooks.filter(
      (webhook) =>
        isDefined(webhook.operations) &&
        webhook.operations.some((operation) =>
          operationsToMatch.includes(operation),
        ),
    );
  }
}
