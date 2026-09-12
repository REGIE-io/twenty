import { Injectable } from '@nestjs/common';

import { WorkspaceService } from 'src/engine/core-modules/workspace/services/workspace.service';
import { WorkspaceDeletionPhase } from 'src/engine/core-modules/workspace/types/workspace-deletion-lifecycle.type';
import { type WorkspaceDeletionPhaseRunners } from 'src/engine/workspace-manager/workspace-cleaner/services/workspace-deletion-phase-executor.service';
import { WorkspaceDeletionTraceService } from 'src/engine/workspace-manager/workspace-cleaner/services/workspace-deletion-trace.service';

@Injectable()
export class WorkspaceDeletionPhaseRunnersService {
  constructor(
    private readonly workspaceService: WorkspaceService,
    private readonly trace: WorkspaceDeletionTraceService,
  ) {}

  build(): WorkspaceDeletionPhaseRunners {
    return {
      [WorkspaceDeletionPhase.MEMBERS]: (workspaceId) =>
        this.run(WorkspaceDeletionPhase.MEMBERS, workspaceId, () =>
          this.workspaceService.hardDeleteWorkspaceMembers(workspaceId),
        ),
      [WorkspaceDeletionPhase.METADATA]: (workspaceId) =>
        this.run(WorkspaceDeletionPhase.METADATA, workspaceId, () =>
          this.workspaceService.hardDeleteWorkspaceMetadata(workspaceId),
        ),
      [WorkspaceDeletionPhase.SCHEMA]: (workspaceId) =>
        this.run(WorkspaceDeletionPhase.SCHEMA, workspaceId, () =>
          this.workspaceService.hardDeleteWorkspaceSchema(workspaceId),
        ),
      [WorkspaceDeletionPhase.CACHE]: (workspaceId) =>
        this.run(WorkspaceDeletionPhase.CACHE, workspaceId, () =>
          this.workspaceService.hardDeleteWorkspaceCaches(workspaceId),
        ),
      [WorkspaceDeletionPhase.EXTERNAL_CLEANUP]: (workspaceId) =>
        this.run(WorkspaceDeletionPhase.EXTERNAL_CLEANUP, workspaceId, () =>
          this.workspaceService.hardDeleteWorkspaceExternalResources(
            workspaceId,
          ),
        ),
      [WorkspaceDeletionPhase.CORE_ROW]: (workspaceId) =>
        this.run(WorkspaceDeletionPhase.CORE_ROW, workspaceId, () =>
          this.workspaceService.hardDeleteWorkspaceCoreRow(workspaceId),
        ),
    };
  }

  private async run(
    phase: WorkspaceDeletionPhase,
    workspaceId: string,
    operation: () => Promise<void>,
  ): Promise<void> {
    this.trace.record({
      event: 'workspace_deletion_phase_started',
      workspaceId,
      phase,
    });
    try {
      await operation();
      this.trace.record({
        event: 'workspace_deletion_phase_finished',
        workspaceId,
        phase,
        result: 'completed',
      });
    } catch (error) {
      this.trace.record({
        event: 'workspace_deletion_phase_finished',
        workspaceId,
        phase,
        result: 'failed',
      });
      throw error;
    }
  }
}
