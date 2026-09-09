import { Injectable, Logger, OnApplicationBootstrap } from '@nestjs/common';

import { InjectMessageQueue } from 'src/engine/core-modules/message-queue/decorators/message-queue.decorator';
import { MessageQueue } from 'src/engine/core-modules/message-queue/message-queue.constants';
import { MessageQueueService } from 'src/engine/core-modules/message-queue/services/message-queue.service';
import { CRONS_TO_REGISTER } from 'src/modules/cron-registration/cron-registration.constants';

/**
 * Registers the crons in CRONS_TO_REGISTER at worker boot.
 *
 * Upstream leaves this to one-off `cron:*` commands, which means nothing syncs on a
 * schedule until someone remembers to run them against each environment, and a Redis loss
 * silently stops everything with no signal. Registration is idempotent — the driver uses
 * `upsertJobScheduler` keyed on the job name — so doing it on every boot costs nothing and
 * makes the schedule self-healing.
 *
 * The commands still exist and still work; this only removes the requirement to run them.
 */
@Injectable()
export class CronRegistrationService implements OnApplicationBootstrap {
  private readonly logger = new Logger(CronRegistrationService.name);

  constructor(
    @InjectMessageQueue(MessageQueue.cronQueue)
    private readonly messageQueueService: MessageQueueService,
  ) {}

  async onApplicationBootstrap(): Promise<void> {
    for (const cron of CRONS_TO_REGISTER) {
      await this.messageQueueService.addCron({
        jobName: cron.jobName,
        data: undefined,
        options: { repeat: { pattern: cron.pattern } },
      });

      this.logger.log(`Registered cron ${cron.jobName} at ${cron.pattern}`);
    }
  }
}
