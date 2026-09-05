import { Injectable } from '@nestjs/common';

import { Process } from 'src/engine/core-modules/message-queue/decorators/process.decorator';
import { InjectMessageQueue } from 'src/engine/core-modules/message-queue/decorators/message-queue.decorator';
import { Processor } from 'src/engine/core-modules/message-queue/decorators/processor.decorator';
import { MessageQueue } from 'src/engine/core-modules/message-queue/message-queue.constants';
import { MessageQueueService } from 'src/engine/core-modules/message-queue/services/message-queue.service';
import { PhoneSearchIndexBackfillService } from 'src/engine/core-modules/phone-search-index/services/phone-search-index-backfill.service';

export type PhoneSearchIndexJobData = { operationId: string };

@Injectable()
@Processor(MessageQueue.phoneSearchIndexQueue)
export class PhoneSearchIndexJob {
  constructor(
    private readonly backfill: PhoneSearchIndexBackfillService,
    @InjectMessageQueue(MessageQueue.phoneSearchIndexQueue)
    private readonly queue: MessageQueueService,
  ) {}

  @Process(PhoneSearchIndexJob.name)
  async handle({ operationId }: PhoneSearchIndexJobData): Promise<void> {
    // Deliberately one batch per delivery: lock/statement timeouts and the
    // committed cursor keep normal CRM traffic available under large imports.
    const completed = await this.backfill.runBatch(operationId);
    if (!completed)
      await this.queue.add(PhoneSearchIndexJob.name, { operationId });
  }
}
