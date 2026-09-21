import { Logger } from '@nestjs/common';
import { Command, CommandRunner } from 'nest-commander';

import { InjectMessageQueue } from 'src/engine/core-modules/message-queue/decorators/message-queue.decorator';
import { MessageQueue } from 'src/engine/core-modules/message-queue/message-queue.constants';
import { MessageQueueService } from 'src/engine/core-modules/message-queue/services/message-queue.service';
import { TwentyConfigService } from 'src/engine/core-modules/twenty-config/twenty-config.service';
import { cleanSuspendedWorkspaceCronPattern } from 'src/engine/workspace-manager/workspace-cleaner/crons/clean-suspended-workspaces.cron.pattern';
import { CleanSuspendedWorkspacesJob } from 'src/engine/workspace-manager/workspace-cleaner/crons/clean-suspended-workspaces.job';

@Command({
  name: 'cron:clean-suspended-workspaces',
  description: 'Starts a cron job to clean suspended workspaces',
})
export class CleanSuspendedWorkspacesCronCommand extends CommandRunner {
  private readonly logger = new Logger(
    CleanSuspendedWorkspacesCronCommand.name,
  );

  constructor(
    @InjectMessageQueue(MessageQueue.cronQueue)
    private readonly messageQueueService: MessageQueueService,
    private readonly twentyConfigService: TwentyConfigService,
  ) {
    super();
  }

  async run(): Promise<void> {
    if (
      !this.twentyConfigService.get('CLEAN_SUSPENDED_WORKSPACES_CRON_ENABLED')
    ) {
      await this.messageQueueService.removeCron({
        jobName: CleanSuspendedWorkspacesJob.name,
      });
      this.logger.log('Disabled legacy suspended-workspace cleanup cron');

      return;
    }

    await this.messageQueueService.addCron<undefined>({
      jobName: CleanSuspendedWorkspacesJob.name,
      data: undefined,
      options: {
        repeat: { pattern: cleanSuspendedWorkspaceCronPattern },
      },
    });
  }
}
