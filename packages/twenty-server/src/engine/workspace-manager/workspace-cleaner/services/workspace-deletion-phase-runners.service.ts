import { Injectable } from '@nestjs/common';

import { WorkspaceDeletionPhaseOperationsService } from 'src/engine/core-modules/workspace/services/workspace-deletion-phase-operations.service';
import { MetricsService } from 'src/engine/core-modules/metrics/metrics.service';
import { MetricsKeys } from 'src/engine/core-modules/metrics/types/metrics-keys.type';
import { WorkspaceDeletionPhase } from 'src/engine/core-modules/workspace/types/workspace-deletion-lifecycle.type';
import { WORKSPACE_DELETION_PHASE_TIMEOUT_MS } from 'src/engine/workspace-manager/workspace-cleaner/constants/workspace-deletion-timeouts.constant';
import { withWorkspaceDeletionDeadline } from 'src/engine/workspace-manager/workspace-cleaner/errors/workspace-deletion-timeout.error';
import { type WorkspaceDeletionPhaseRunners } from 'src/engine/workspace-manager/workspace-cleaner/services/workspace-deletion-phase-executor.service';
import { WorkspaceDeletionTraceService } from 'src/engine/workspace-manager/workspace-cleaner/services/workspace-deletion-trace.service';

@Injectable()
export class WorkspaceDeletionPhaseRunnersService {
  constructor(
    private readonly operations: WorkspaceDeletionPhaseOperationsService,
    private readonly trace: WorkspaceDeletionTraceService,
    private readonly metrics: MetricsService,
  ) {}

  build(): WorkspaceDeletionPhaseRunners {
    return {
      [WorkspaceDeletionPhase.MEMBERS]: (workspaceId) =>
        this.run(WorkspaceDeletionPhase.MEMBERS, workspaceId, () =>
          this.operations.deleteMembers(workspaceId),
        ),
      [WorkspaceDeletionPhase.METADATA]: (workspaceId) =>
        this.run(WorkspaceDeletionPhase.METADATA, workspaceId, () =>
          this.operations.deleteMetadata(workspaceId),
        ),
      [WorkspaceDeletionPhase.SCHEMA]: (workspaceId) =>
        this.run(WorkspaceDeletionPhase.SCHEMA, workspaceId, () =>
          this.operations.deleteSchema(workspaceId),
        ),
      [WorkspaceDeletionPhase.CACHE]: (workspaceId) =>
        this.run(WorkspaceDeletionPhase.CACHE, workspaceId, () =>
          this.operations.deleteCaches(workspaceId),
        ),
      [WorkspaceDeletionPhase.EXTERNAL_CLEANUP]: (workspaceId) =>
        this.run(WorkspaceDeletionPhase.EXTERNAL_CLEANUP, workspaceId, () =>
          this.operations.deleteExternalResources(workspaceId),
        ),
      [WorkspaceDeletionPhase.CORE_ROW]: (workspaceId) =>
        this.run(WorkspaceDeletionPhase.CORE_ROW, workspaceId, () =>
          this.operations.deleteCoreRow(workspaceId),
        ),
    };
  }

  private async run(
    phase: WorkspaceDeletionPhase,
    workspaceId: string,
    operation: () => Promise<void>,
  ): Promise<void> {
    const startedAt = Date.now();
    let result = 'completed';

    this.trace.record({
      event: 'workspace_deletion_phase_started',
      workspaceId,
      phase,
    });
    try {
      await withWorkspaceDeletionDeadline(
        operation(),
        WORKSPACE_DELETION_PHASE_TIMEOUT_MS,
        'WORKSPACE_DELETION_PHASE_TIMEOUT',
      );
      this.trace.record({
        event: 'workspace_deletion_phase_finished',
        workspaceId,
        phase,
        result: 'completed',
      });
    } catch (error) {
      result = 'failed';
      this.trace.record({
        event: 'workspace_deletion_phase_finished',
        workspaceId,
        phase,
        result: 'failed',
      });
      throw error;
    } finally {
      this.metrics.recordHistogram({
        key: MetricsKeys.WorkspaceDeletionPhaseDurationMs,
        value: Date.now() - startedAt,
        unit: 'ms',
        attributes: { phase, result },
      });
    }
  }
}
