import { Process } from 'src/engine/core-modules/message-queue/decorators/process.decorator';
import { Processor } from 'src/engine/core-modules/message-queue/decorators/processor.decorator';
import { MessageQueue } from 'src/engine/core-modules/message-queue/message-queue.constants';
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
  ) {}

  @Process(WorkspaceDeletionJob.name)
  async handle({ workspaceId }: WorkspaceDeletionJobData): Promise<void> {
    this.trace.record({ event: 'workspace_deletion_started', workspaceId });

    const result = await this.coordinator.execute(
      workspaceId,
      this.phaseRunners.build(),
      { now: new Date(), staleAfterMs: 30_000, maxAttempts: 3 },
    );

    this.trace.record({
      event: 'workspace_deletion_finished',
      workspaceId,
      result: result.status,
    });

    if (result.status === 'retryable-failure') {
      throw result.error;
    }
  }
}
