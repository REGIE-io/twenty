import { Process } from 'src/engine/core-modules/message-queue/decorators/process.decorator';
import { Processor } from 'src/engine/core-modules/message-queue/decorators/processor.decorator';
import { MessageQueue } from 'src/engine/core-modules/message-queue/message-queue.constants';
import { ExceptionHandlerService } from 'src/engine/core-modules/exception-handler/exception-handler.service';
import { MetricsService } from 'src/engine/core-modules/metrics/metrics.service';
import { MetricsKeys } from 'src/engine/core-modules/metrics/types/metrics-keys.type';
import { WorkspaceDeletionCoordinatorService } from 'src/engine/workspace-manager/workspace-cleaner/services/workspace-deletion-coordinator.service';
import { WorkspaceDeletionPhaseRunnersService } from 'src/engine/workspace-manager/workspace-cleaner/services/workspace-deletion-phase-runners.service';
import { WorkspaceDeletionTraceService } from 'src/engine/workspace-manager/workspace-cleaner/services/workspace-deletion-trace.service';

export type WorkspaceDeletionJobData = { workspaceId: string };

@Processor(MessageQueue.workspaceCleanupQueue)
export class WorkspaceDeletionJob {
  constructor(
    private readonly coordinator: WorkspaceDeletionCoordinatorService,
    private readonly phaseRunners: WorkspaceDeletionPhaseRunnersService,
    private readonly trace: WorkspaceDeletionTraceService,
    private readonly metrics: MetricsService,
    private readonly exceptionHandler: ExceptionHandlerService,
  ) {}

  @Process(WorkspaceDeletionJob.name)
  async handle({ workspaceId }: WorkspaceDeletionJobData): Promise<void> {
    this.trace.record({ event: 'workspace_deletion_started', workspaceId });

    const result = await this.coordinator.execute(
      workspaceId,
      this.phaseRunners.build(),
      { now: new Date(), staleAfterMs: 30_000, maxAttempts: 3 },
    );

    if (
      result.status === 'retryable-failure' ||
      result.status === 'terminal-failure'
    ) {
      const deletionKind = result.deletionKind ?? 'UNKNOWN';
      const capturedError =
        result.error instanceof Error
          ? result.error
          : new Error(String(result.error));
      const errorMessage = capturedError.message;
      const attributes = {
        deletionKind,
        phase: result.phase,
        result: result.status,
        errorCode: result.errorCode,
      };

      this.trace.record({
        event: 'workspace_deletion_failed',
        workspaceId,
        ...attributes,
        attempt: result.attempt,
        errorMessage,
      });
      void this.metrics.incrementCounterForEvent({
        key: MetricsKeys.WorkspaceDeletionFailed,
        attributes,
        shouldStoreInCache: false,
      });
      this.exceptionHandler.captureExceptions([capturedError], {
        workspace: { id: workspaceId },
        additionalData: {
          deletionKind,
          phase: result.phase,
          attempt: result.attempt,
          result: result.status,
          errorCode: result.errorCode,
        },
      });

      if (result.status === 'retryable-failure') {
        throw result.error;
      }

      return;
    }

    this.trace.record({
      event: 'workspace_deletion_finished',
      workspaceId,
      result: result.status,
    });

    if (result.status === 'completed') {
      void this.metrics.incrementCounterForEvent({
        key: MetricsKeys.WorkspaceDeletionCompleted,
        attributes: { deletionKind: result.deletionKind ?? 'UNKNOWN' },
        shouldStoreInCache: false,
      });
    }
  }
}
