import { WorkspaceDeletionPhase } from 'src/engine/core-modules/workspace/types/workspace-deletion-lifecycle.type';
import { type WorkspaceService } from 'src/engine/core-modules/workspace/services/workspace.service';
import { WorkspaceDeletionPhaseRunnersService } from 'src/engine/workspace-manager/workspace-cleaner/services/workspace-deletion-phase-runners.service';
import { type WorkspaceDeletionTraceService } from 'src/engine/workspace-manager/workspace-cleaner/services/workspace-deletion-trace.service';

describe('WorkspaceDeletionPhaseRunnersService', () => {
  it('maps every persisted phase to one concrete idempotent workspace operation', async () => {
    const workspaceId = '20202020-0000-4000-8000-000000000001';
    const workspaceService = {
      hardDeleteWorkspaceMembers: jest.fn(),
      hardDeleteWorkspaceMetadata: jest.fn(),
      hardDeleteWorkspaceSchema: jest.fn(),
      hardDeleteWorkspaceCaches: jest.fn(),
      hardDeleteWorkspaceExternalResources: jest.fn(),
      hardDeleteWorkspaceCoreRow: jest.fn(),
    } as unknown as WorkspaceService;
    const trace = { record: jest.fn() };
    const runners = new WorkspaceDeletionPhaseRunnersService(
      workspaceService,
      trace as unknown as WorkspaceDeletionTraceService,
    ).build();

    for (const phase of Object.values(WorkspaceDeletionPhase)) {
      await runners[phase](workspaceId);
    }

    expect(workspaceService.hardDeleteWorkspaceMembers).toHaveBeenCalledWith(
      workspaceId,
    );
    expect(workspaceService.hardDeleteWorkspaceMetadata).toHaveBeenCalledWith(
      workspaceId,
    );
    expect(workspaceService.hardDeleteWorkspaceSchema).toHaveBeenCalledWith(
      workspaceId,
    );
    expect(workspaceService.hardDeleteWorkspaceCaches).toHaveBeenCalledWith(
      workspaceId,
    );
    expect(
      workspaceService.hardDeleteWorkspaceExternalResources,
    ).toHaveBeenCalledWith(workspaceId);
    expect(workspaceService.hardDeleteWorkspaceCoreRow).toHaveBeenCalledWith(
      workspaceId,
    );
    expect(trace.record).toHaveBeenCalledWith({
      event: 'workspace_deletion_phase_started',
      workspaceId,
      phase: WorkspaceDeletionPhase.MEMBERS,
    });
    expect(trace.record).toHaveBeenCalledWith({
      event: 'workspace_deletion_phase_finished',
      workspaceId,
      phase: WorkspaceDeletionPhase.CORE_ROW,
      result: 'completed',
    });
  });
});
