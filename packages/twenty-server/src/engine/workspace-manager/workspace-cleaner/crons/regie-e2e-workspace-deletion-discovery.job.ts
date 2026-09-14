import { REGIE_E2E_PURGE_GRACE_PERIOD_MS } from 'src/engine/core-modules/auth/constants/regie-e2e-workspace-marker.constant';
import { SentryCronMonitor } from 'src/engine/core-modules/cron/sentry-cron-monitor.decorator';
import { Process } from 'src/engine/core-modules/message-queue/decorators/process.decorator';
import { Processor } from 'src/engine/core-modules/message-queue/decorators/processor.decorator';
import { MessageQueue } from 'src/engine/core-modules/message-queue/message-queue.constants';
import { TwentyConfigService } from 'src/engine/core-modules/twenty-config/twenty-config.service';
import {
  WORKSPACE_DELETION_OPERATIONAL_MAX_AGE_MS,
  WORKSPACE_DELETION_OPERATIONAL_STALE_AFTER_MS,
} from 'src/engine/workspace-manager/workspace-cleaner/constants/workspace-deletion-timeouts.constant';
import { RegieE2eWorkspaceDeletionDiscoveryService } from 'src/engine/workspace-manager/workspace-cleaner/services/regie-e2e-workspace-deletion-discovery.service';
import { WorkspaceDeletionMonitoringService } from 'src/engine/workspace-manager/workspace-cleaner/services/workspace-deletion-monitoring.service';
import { WorkspaceDeletionQueueAdapter } from 'src/engine/workspace-manager/workspace-cleaner/services/workspace-deletion-queue.adapter';
import { WorkspaceDeletionTraceService } from 'src/engine/workspace-manager/workspace-cleaner/services/workspace-deletion-trace.service';

export const REGIE_E2E_WORKSPACE_DELETION_CRON_PATTERN = '*/10 * * * *';

@Processor(MessageQueue.cronQueue)
export class RegieE2eWorkspaceDeletionDiscoveryJob {
  constructor(
    private readonly discovery: RegieE2eWorkspaceDeletionDiscoveryService,
    private readonly queue: WorkspaceDeletionQueueAdapter,
    private readonly config: TwentyConfigService,
    private readonly monitoring: WorkspaceDeletionMonitoringService,
    private readonly trace: WorkspaceDeletionTraceService,
  ) {}

  @Process(RegieE2eWorkspaceDeletionDiscoveryJob.name)
  @SentryCronMonitor(
    RegieE2eWorkspaceDeletionDiscoveryJob.name,
    REGIE_E2E_WORKSPACE_DELETION_CRON_PATTERN,
  )
  async handle(
    now = new Date(),
  ): Promise<{ recovered: number; admitted: number }> {
    const result = await this.discovery.discover(this.queue, {
      now,
      gracePeriodMs: REGIE_E2E_PURGE_GRACE_PERIOD_MS,
      staleAfterMs: 30_000,
      recoveryLimit: this.config.get(
        'REGIE_E2E_WORKSPACE_DELETION_RECOVERY_LIMIT',
      ),
      admissionLimit: this.config.get(
        'REGIE_E2E_WORKSPACE_DELETION_ADMISSION_LIMIT',
      ),
    });

    const { summary } = await this.monitoring.report(
      now,
      WORKSPACE_DELETION_OPERATIONAL_STALE_AFTER_MS,
    );

    this.trace.record({
      event: 'workspace_deletion_backlog_snapshot',
      ...summary,
    });

    if (summary.stalled > 0) {
      this.trace.record({
        event: 'workspace_deletion_backlog_stalled',
        ...summary,
      });
    }
    if (summary.terminalFailures > 0) {
      this.trace.record({
        event: 'workspace_deletion_backlog_terminal',
        ...summary,
      });
    }
    if (summary.oldestAgeMs >= WORKSPACE_DELETION_OPERATIONAL_MAX_AGE_MS) {
      this.trace.record({
        event: 'workspace_deletion_backlog_old',
        ...summary,
      });
    }

    return result;
  }
}
