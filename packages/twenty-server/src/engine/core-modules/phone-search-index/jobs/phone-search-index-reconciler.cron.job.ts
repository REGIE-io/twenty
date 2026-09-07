import { Injectable } from '@nestjs/common';

import { SentryCronMonitor } from 'src/engine/core-modules/cron/sentry-cron-monitor.decorator';
import { PHONE_SEARCH_INDEX_RECONCILER_CRON_PATTERN } from 'src/engine/core-modules/phone-search-index/constants/phone-search-index-reconciler-cron-pattern.constant';
import { Process } from 'src/engine/core-modules/message-queue/decorators/process.decorator';
import { Processor } from 'src/engine/core-modules/message-queue/decorators/processor.decorator';
import { MessageQueue } from 'src/engine/core-modules/message-queue/message-queue.constants';
import { PhoneSearchIndexReconcilerService } from 'src/engine/core-modules/phone-search-index/services/phone-search-index-reconciler.service';

@Injectable()
@Processor(MessageQueue.cronQueue)
export class PhoneSearchIndexReconcilerCronJob {
  constructor(private readonly reconciler: PhoneSearchIndexReconcilerService) {}

  @Process(PhoneSearchIndexReconcilerCronJob.name)
  @SentryCronMonitor(
    PhoneSearchIndexReconcilerCronJob.name,
    PHONE_SEARCH_INDEX_RECONCILER_CRON_PATTERN,
  )
  async handle(): Promise<void> {
    await this.reconciler.reconcile();
  }
}
