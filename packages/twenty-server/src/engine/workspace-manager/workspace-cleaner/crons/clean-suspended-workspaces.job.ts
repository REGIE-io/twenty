import { InjectMessageQueue } from 'src/engine/core-modules/message-queue/decorators/message-queue.decorator';
import { SentryCronMonitor } from 'src/engine/core-modules/cron/sentry-cron-monitor.decorator';
import { Process } from 'src/engine/core-modules/message-queue/decorators/process.decorator';
import { Processor } from 'src/engine/core-modules/message-queue/decorators/processor.decorator';
import { MessageQueue } from 'src/engine/core-modules/message-queue/message-queue.constants';
import { MessageQueueService } from 'src/engine/core-modules/message-queue/services/message-queue.service';
import { cleanSuspendedWorkspaceCronPattern } from 'src/engine/workspace-manager/workspace-cleaner/crons/clean-suspended-workspaces.cron.pattern';
import { CleanSuspendedWorkspacesBatchJob } from 'src/engine/workspace-manager/workspace-cleaner/jobs/clean-suspended-workspaces-batch.job';

@Processor(MessageQueue.cronQueue)
export class CleanSuspendedWorkspacesJob {
  constructor(
    @InjectMessageQueue(MessageQueue.workspaceCleanupQueue)
    private readonly messageQueueService: MessageQueueService,
  ) {}

  @Process(CleanSuspendedWorkspacesJob.name)
  @SentryCronMonitor(
    CleanSuspendedWorkspacesJob.name,
    cleanSuspendedWorkspaceCronPattern,
  )
  async handle(): Promise<void> {
    await this.messageQueueService.add(
      CleanSuspendedWorkspacesBatchJob.name,
      {},
    );
  }
}
