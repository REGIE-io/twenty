import { Logger } from '@nestjs/common';

import crypto from 'crypto';

import { ensureAbsoluteUrl } from 'twenty-shared/utils';

import { Process } from 'src/engine/core-modules/message-queue/decorators/process.decorator';
import { Processor } from 'src/engine/core-modules/message-queue/decorators/processor.decorator';
import { MessageQueue } from 'src/engine/core-modules/message-queue/message-queue.constants';
import { SecureHttpClientService } from 'src/engine/core-modules/secure-http-client/secure-http-client.service';
import { type CallMessageReceivedWebhookJobData } from 'src/modules/messaging/message-import-manager/types/message-received-webhook-payload.type';

const WEBHOOK_TIMEOUT_MS = 5_000;

@Processor(MessageQueue.webhookQueue)
export class CallMessageReceivedWebhookJob {
  private readonly logger = new Logger(CallMessageReceivedWebhookJob.name);

  constructor(
    private readonly secureHttpClientService: SecureHttpClientService,
  ) {}

  // Same envelope as Twenty's own webhooks so a receiver verifies one way for both:
  // HMAC-SHA256 over `${timestamp}:${JSON.stringify(payload)}`.
  private sign(
    payload: Record<string, unknown>,
    secret: string,
    timestamp: string,
  ): string {
    return crypto
      .createHmac('sha256', secret)
      .update(`${timestamp}:${JSON.stringify(payload)}`)
      .digest('hex');
  }

  @Process(CallMessageReceivedWebhookJob.name)
  async handle(data: CallMessageReceivedWebhookJobData): Promise<void> {
    const { targetUrl, secret, payload, workspaceId } = data;

    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
    };

    if (secret) {
      const timestamp = Date.now().toString();

      headers['X-Twenty-Webhook-Timestamp'] = timestamp;
      headers['X-Twenty-Webhook-Signature'] = this.sign(
        payload,
        secret,
        timestamp,
      );
      headers['X-Twenty-Webhook-Nonce'] = crypto
        .randomBytes(16)
        .toString('hex');
    }

    const axiosClient = this.secureHttpClientService.getHttpClient(undefined, {
      workspaceId,
      source: 'webhook',
    });

    try {
      await axiosClient.post(ensureAbsoluteUrl(targetUrl), payload, {
        headers,
        timeout: WEBHOOK_TIMEOUT_MS,
      });
    } catch (error) {
      // Rethrow so BullMQ retries per the retryLimit set at enqueue time. A receiver
      // that stays down past the retries is caught by the reconciliation pull.
      this.logger.warn(
        `message.received webhook ${data.webhookId} failed for message ${payload.messageId}: ${
          error instanceof Error ? error.message : 'unknown error'
        }`,
      );
      throw error;
    }
  }
}
