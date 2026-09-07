import { Command, CommandRunner } from 'nest-commander';

import { PHONE_SEARCH_INDEX_RECONCILER_CRON_PATTERN } from 'src/engine/core-modules/phone-search-index/constants/phone-search-index-reconciler-cron-pattern.constant';
import { PhoneSearchIndexReconcilerCronJob } from 'src/engine/core-modules/phone-search-index/jobs/phone-search-index-reconciler.cron.job';
import { InjectMessageQueue } from 'src/engine/core-modules/message-queue/decorators/message-queue.decorator';
import { MessageQueue } from 'src/engine/core-modules/message-queue/message-queue.constants';
import { MessageQueueService } from 'src/engine/core-modules/message-queue/services/message-queue.service';

@Command({ name: 'cron:phone-search-index-reconciler' })
export class PhoneSearchIndexReconcilerCronCommand extends CommandRunner {
  constructor(
    @InjectMessageQueue(MessageQueue.cronQueue)
    private readonly queue: MessageQueueService,
  ) {
    super();
  }

  async run(): Promise<void> {
    await this.queue.addCron({
      jobName: PhoneSearchIndexReconcilerCronJob.name,
      data: undefined,
      options: {
        repeat: { pattern: PHONE_SEARCH_INDEX_RECONCILER_CRON_PATTERN },
      },
    });
  }
}
