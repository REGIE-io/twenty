import { Command, CommandRunner } from 'nest-commander';

import { InjectMessageQueue } from 'src/engine/core-modules/message-queue/decorators/message-queue.decorator';
import { MessageQueue } from 'src/engine/core-modules/message-queue/message-queue.constants';
import { MessageQueueService } from 'src/engine/core-modules/message-queue/services/message-queue.service';
import {
  REGIE_E2E_WORKSPACE_DELETION_CRON_PATTERN,
  RegieE2eWorkspaceDeletionDiscoveryJob,
} from 'src/engine/workspace-manager/workspace-cleaner/crons/regie-e2e-workspace-deletion-discovery.job';

@Command({
  name: 'cron:regie-e2e-workspace-deletion-discovery',
  description: 'Discovers and recovers Regie E2E workspace deletions',
})
export class RegieE2eWorkspaceDeletionDiscoveryCronCommand extends CommandRunner {
  constructor(
    @InjectMessageQueue(MessageQueue.cronQueue)
    private readonly queue: MessageQueueService,
  ) {
    super();
  }

  async run(): Promise<void> {
    await this.queue.addCron<undefined>({
      jobName: RegieE2eWorkspaceDeletionDiscoveryJob.name,
      data: undefined,
      options: {
        repeat: { pattern: REGIE_E2E_WORKSPACE_DELETION_CRON_PATTERN },
      },
    });
  }
}
