import { Injectable } from '@nestjs/common';

import { InjectMessageQueue } from 'src/engine/core-modules/message-queue/decorators/message-queue.decorator';
import { Process } from 'src/engine/core-modules/message-queue/decorators/process.decorator';
import { Processor } from 'src/engine/core-modules/message-queue/decorators/processor.decorator';
import { MessageQueue } from 'src/engine/core-modules/message-queue/message-queue.constants';
import { MessageQueueService } from 'src/engine/core-modules/message-queue/services/message-queue.service';
import {
  type ClaimedSearchVectorBackfillJob,
  SearchVectorBackfillService,
} from 'src/engine/core-modules/search-vector-trigger/services/search-vector-backfill.service';

const SEARCH_VECTOR_BACKFILL_DELAY_BETWEEN_BATCHES_MS = 200;

@Injectable()
@Processor(MessageQueue.searchVectorBackfillQueue)
export class SearchVectorBackfillJob {
  constructor(
    private readonly searchVectorBackfillService: SearchVectorBackfillService,
    @InjectMessageQueue(MessageQueue.searchVectorBackfillQueue)
    private readonly messageQueueService: MessageQueueService,
  ) {}

  // One batch per message, with a pause before the next so the table gets room for normal saves.
  @Process(SearchVectorBackfillJob.name)
  async handle(claimedJob: ClaimedSearchVectorBackfillJob): Promise<void> {
    const isFinished =
      await this.searchVectorBackfillService.runBatch(claimedJob);

    if (!isFinished) {
      await this.messageQueueService.add(
        SearchVectorBackfillJob.name,
        claimedJob,
        { delay: SEARCH_VECTOR_BACKFILL_DELAY_BETWEEN_BATCHES_MS },
      );
    }
  }
}
