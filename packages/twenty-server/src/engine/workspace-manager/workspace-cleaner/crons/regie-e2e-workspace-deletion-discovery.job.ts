import {
  REGIE_E2E_PURGE_BATCH_SIZE,
  REGIE_E2E_PURGE_GRACE_PERIOD_MS,
} from 'src/engine/core-modules/auth/constants/regie-e2e-workspace-marker.constant';
import { SentryCronMonitor } from 'src/engine/core-modules/cron/sentry-cron-monitor.decorator';
import { Process } from 'src/engine/core-modules/message-queue/decorators/process.decorator';
import { Processor } from 'src/engine/core-modules/message-queue/decorators/processor.decorator';
import { MessageQueue } from 'src/engine/core-modules/message-queue/message-queue.constants';
import { RegieE2eWorkspaceDeletionDiscoveryService } from 'src/engine/workspace-manager/workspace-cleaner/services/regie-e2e-workspace-deletion-discovery.service';
import { WorkspaceDeletionQueueAdapter } from 'src/engine/workspace-manager/workspace-cleaner/services/workspace-deletion-queue.adapter';

export const REGIE_E2E_WORKSPACE_DELETION_CRON_PATTERN = '*/10 * * * *';

@Processor(MessageQueue.cronQueue)
export class RegieE2eWorkspaceDeletionDiscoveryJob {
  constructor(
    private readonly discovery: RegieE2eWorkspaceDeletionDiscoveryService,
    private readonly queue: WorkspaceDeletionQueueAdapter,
  ) {}

  @Process(RegieE2eWorkspaceDeletionDiscoveryJob.name)
  @SentryCronMonitor(
    RegieE2eWorkspaceDeletionDiscoveryJob.name,
    REGIE_E2E_WORKSPACE_DELETION_CRON_PATTERN,
  )
  handle(now = new Date()): Promise<{ recovered: number; admitted: number }> {
    return this.discovery.discover(this.queue, {
      now,
      gracePeriodMs: REGIE_E2E_PURGE_GRACE_PERIOD_MS,
      staleAfterMs: 30_000,
      limit: REGIE_E2E_PURGE_BATCH_SIZE,
    });
  }
}
