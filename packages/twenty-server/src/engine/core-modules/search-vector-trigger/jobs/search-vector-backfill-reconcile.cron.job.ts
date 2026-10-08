import { Injectable } from '@nestjs/common';

import { SentryCronMonitor } from 'src/engine/core-modules/cron/sentry-cron-monitor.decorator';
import { InjectMessageQueue } from 'src/engine/core-modules/message-queue/decorators/message-queue.decorator';
import { Process } from 'src/engine/core-modules/message-queue/decorators/process.decorator';
import { Processor } from 'src/engine/core-modules/message-queue/decorators/processor.decorator';
import { MessageQueue } from 'src/engine/core-modules/message-queue/message-queue.constants';
import { MessageQueueService } from 'src/engine/core-modules/message-queue/services/message-queue.service';
import { SearchVectorBackfillJob } from 'src/engine/core-modules/search-vector-trigger/jobs/search-vector-backfill.job';
import { SearchVectorBackfillService } from 'src/engine/core-modules/search-vector-trigger/services/search-vector-backfill.service';

export const SEARCH_VECTOR_BACKFILL_RECONCILE_CRON_PATTERN = '* * * * *';

// Job rows, not Redis, hold the work: this picks up new jobs, retries and crashed workers.
@Injectable()
@Processor(MessageQueue.cronQueue)
export class SearchVectorBackfillReconcileCronJob {
  constructor(
    private readonly searchVectorBackfillService: SearchVectorBackfillService,
    @InjectMessageQueue(MessageQueue.searchVectorBackfillQueue)
    private readonly messageQueueService: MessageQueueService,
  ) {}

  @Process(SearchVectorBackfillReconcileCronJob.name)
  @SentryCronMonitor(
    SearchVectorBackfillReconcileCronJob.name,
    SEARCH_VECTOR_BACKFILL_RECONCILE_CRON_PATTERN,
  )
  async handle(): Promise<void> {
    await this.searchVectorBackfillService.failExpiredLeases();

    const claimedJobs =
      await this.searchVectorBackfillService.claimRunnableJobs();

    for (const claimedJob of claimedJobs) {
      await this.messageQueueService.add(
        SearchVectorBackfillJob.name,
        claimedJob,
      );
    }

    await this.searchVectorBackfillService.reportStuckJobs();
    await this.searchVectorBackfillService.deleteOldCompletedJobs();
  }
}
