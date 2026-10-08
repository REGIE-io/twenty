import { Command, CommandRunner } from 'nest-commander';

import { InjectMessageQueue } from 'src/engine/core-modules/message-queue/decorators/message-queue.decorator';
import { MessageQueue } from 'src/engine/core-modules/message-queue/message-queue.constants';
import { MessageQueueService } from 'src/engine/core-modules/message-queue/services/message-queue.service';
import {
  SEARCH_VECTOR_BACKFILL_RECONCILE_CRON_PATTERN,
  SearchVectorBackfillReconcileCronJob,
} from 'src/engine/core-modules/search-vector-trigger/jobs/search-vector-backfill-reconcile.cron.job';

@Command({ name: 'cron:search-vector-backfill-reconcile' })
export class SearchVectorBackfillReconcileCronCommand extends CommandRunner {
  constructor(
    @InjectMessageQueue(MessageQueue.cronQueue)
    private readonly messageQueueService: MessageQueueService,
  ) {
    super();
  }

  async run(): Promise<void> {
    await this.messageQueueService.addCron({
      jobName: SearchVectorBackfillReconcileCronJob.name,
      data: undefined,
      options: {
        repeat: { pattern: SEARCH_VECTOR_BACKFILL_RECONCILE_CRON_PATTERN },
      },
    });
  }
}
