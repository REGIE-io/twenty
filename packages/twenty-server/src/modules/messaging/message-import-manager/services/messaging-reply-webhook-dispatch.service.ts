import { Injectable, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';

import { isDefined } from 'twenty-shared/utils';
import { Repository } from 'typeorm';

import { InjectMessageQueue } from 'src/engine/core-modules/message-queue/decorators/message-queue.decorator';
import { MessageQueue } from 'src/engine/core-modules/message-queue/message-queue.constants';
import { MessageQueueService } from 'src/engine/core-modules/message-queue/services/message-queue.service';
import { WebhookEntity } from 'src/engine/metadata-modules/webhook/entities/webhook.entity';
import { MessageDirection } from 'src/modules/messaging/common/enums/message-direction.enum';
import {
  MESSAGE_RECEIVED_WEBHOOK_EVENT,
  MESSAGE_SENT_WEBHOOK_EVENT,
  buildMessageWebhookOperationsToMatch,
} from 'src/modules/messaging/message-import-manager/constants/messaging-reply-webhook.constant';
import { CallMessageReceivedWebhookJob } from 'src/modules/messaging/message-import-manager/jobs/call-message-received-webhook.job';
import { type CallMessageSyncWebhookJobData } from 'src/modules/messaging/message-import-manager/types/message-received-webhook-payload.type';

export type SyncedMessageForWebhook = {
  messageId: string;
  messageExternalId: string;
  headerMessageId: string | null;
  threadId: string | null;
  to: string[];
  direction: MessageDirection;
  receivedAt: Date | null;
};

export type DispatchSyncedMessageWebhooksInput = {
  workspaceId: string;
  channelId: string;
  connectedAccountId: string;
  handle: string;
  messages: SyncedMessageForWebhook[];
};

@Injectable()
export class MessagingReplyWebhookDispatchService {
  private readonly logger = new Logger(
    MessagingReplyWebhookDispatchService.name,
  );

  constructor(
    // WebhookEntity is a core-schema entity, not a workspace object, so the
    // workspace-scoped repository does not apply; lookups filter by workspaceId.
    // eslint-disable-next-line twenty/prefer-workspace-scoped-repository
    @InjectRepository(WebhookEntity)
    private readonly webhookRepository: Repository<WebhookEntity>,
    @InjectMessageQueue(MessageQueue.webhookQueue)
    private readonly messageQueueService: MessageQueueService,
  ) {}

  async dispatchSyncedMessageWebhooks(
    input: DispatchSyncedMessageWebhooksInput,
  ): Promise<void> {
    const { workspaceId, channelId, connectedAccountId, handle, messages } =
      input;

    if (messages.length === 0) {
      return;
    }

    const webhooks = await this.webhookRepository.find({
      where: { workspaceId },
    });

    if (webhooks.length === 0) {
      return;
    }

    let dispatchedCount = 0;

    // One job per webhook per message: the receiver dedupes on messageExternalId, and a
    // single failing endpoint retries without holding up the others.
    for (const message of messages) {
      const eventName = this.getEventName(message.direction);
      const matchingWebhooks = this.filterWebhooksByEvent(webhooks, eventName);

      for (const webhook of matchingWebhooks) {
        const jobData: CallMessageSyncWebhookJobData = {
          targetUrl: webhook.targetUrl,
          secret: webhook.secret,
          webhookId: webhook.id,
          workspaceId,
          payload: {
            eventName,
            webhookId: webhook.id,
            workspaceId,
            messageId: message.messageId,
            messageExternalId: message.messageExternalId,
            headerMessageId: message.headerMessageId,
            threadId: message.threadId,
            channelId,
            connectedAccountId,
            handle,
            to: message.to,
            direction: message.direction,
            receivedAt: message.receivedAt?.toISOString() ?? null,
          },
        };

        await this.messageQueueService.add<CallMessageSyncWebhookJobData>(
          CallMessageReceivedWebhookJob.name,
          jobData,
          { retryLimit: 3 },
        );

        dispatchedCount += 1;
      }
    }

    if (dispatchedCount > 0) {
      this.logger.log(
        `Dispatched ${dispatchedCount} message sync webhook job(s) for ${messages.length} message(s) in workspace ${workspaceId}`,
      );
    }
  }

  private getEventName(direction: MessageDirection): string {
    return direction === MessageDirection.OUTGOING
      ? MESSAGE_SENT_WEBHOOK_EVENT
      : MESSAGE_RECEIVED_WEBHOOK_EVENT;
  }

  private filterWebhooksByEvent(
    webhooks: WebhookEntity[],
    eventName: string,
  ): WebhookEntity[] {
    const operationsToMatch = buildMessageWebhookOperationsToMatch(eventName);

    return webhooks.filter(
      (webhook) =>
        isDefined(webhook.operations) &&
        webhook.operations.some((operation) =>
          operationsToMatch.includes(operation),
        ),
    );
  }
}
