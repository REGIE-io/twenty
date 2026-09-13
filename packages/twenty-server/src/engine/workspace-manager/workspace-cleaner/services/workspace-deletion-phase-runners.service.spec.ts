import { type MetricsService } from 'src/engine/core-modules/metrics/metrics.service';
import { WorkspaceDeletionPhase } from 'src/engine/core-modules/workspace/types/workspace-deletion-lifecycle.type';
import { type WorkspaceService } from 'src/engine/core-modules/workspace/services/workspace.service';
import { WORKSPACE_DELETION_PHASE_TIMEOUT_MS } from 'src/engine/workspace-manager/workspace-cleaner/constants/workspace-deletion-timeouts.constant';
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
    const metrics = { recordHistogram: jest.fn() };
    const service = Reflect.construct(WorkspaceDeletionPhaseRunnersService, [
      workspaceService,
      trace as unknown as WorkspaceDeletionTraceService,
      metrics as unknown as MetricsService,
    ]);
    const runners = service.build();

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
    expect(metrics.recordHistogram).toHaveBeenCalledWith({
      key: 'workspace-deletion/phase-duration-ms',
      value: expect.any(Number),
      unit: 'ms',
      attributes: {
        phase: WorkspaceDeletionPhase.MEMBERS,
        result: 'completed',
      },
    });
  });

  it('records failed phase duration and progress without swallowing the error', async () => {
    const workspaceId = '20202020-0000-4000-8000-000000000001';
    const failure = new Error('metadata statement timeout');
    const workspaceService = {
      hardDeleteWorkspaceMetadata: jest.fn().mockRejectedValue(failure),
    } as unknown as WorkspaceService;
    const trace = { record: jest.fn() };
    const metrics = { recordHistogram: jest.fn() };
    const service = Reflect.construct(WorkspaceDeletionPhaseRunnersService, [
      workspaceService,
      trace as unknown as WorkspaceDeletionTraceService,
      metrics as unknown as MetricsService,
    ]);

    await expect(
      service.build()[WorkspaceDeletionPhase.METADATA](workspaceId),
    ).rejects.toBe(failure);

    expect(trace.record).toHaveBeenLastCalledWith({
      event: 'workspace_deletion_phase_finished',
      workspaceId,
      phase: WorkspaceDeletionPhase.METADATA,
      result: 'failed',
    });
    expect(metrics.recordHistogram).toHaveBeenCalledWith({
      key: 'workspace-deletion/phase-duration-ms',
      value: expect.any(Number),
      unit: 'ms',
      attributes: {
        phase: WorkspaceDeletionPhase.METADATA,
        result: 'failed',
      },
    });
  });

  it('fails a phase at its overall deadline even when the underlying operation eventually resolves', async () => {
    const workspaceService = {
      hardDeleteWorkspaceMetadata: jest.fn(
        () => new Promise<void>((resolve) => setTimeout(resolve, 70_000)),
      ),
    } as unknown as WorkspaceService;
    const trace = { record: jest.fn() };
    const metrics = { recordHistogram: jest.fn() };
    const service = Reflect.construct(WorkspaceDeletionPhaseRunnersService, [
      workspaceService,
      trace as unknown as WorkspaceDeletionTraceService,
      metrics as unknown as MetricsService,
    ]);

    const execution = service
      .build()
      [WorkspaceDeletionPhase.METADATA]('20202020-0000-4000-8000-000000000001');
    const outcome = execution.then(
      () => ({ resolved: true }),
      (error) => ({ error }),
    );
    let settled = false;

    void outcome.then(() => {
      settled = true;
    });

    await jest.advanceTimersByTimeAsync(WORKSPACE_DELETION_PHASE_TIMEOUT_MS);

    expect(settled).toBe(false);
    expect(trace.record).not.toHaveBeenCalledWith(
      expect.objectContaining({
        event: 'workspace_deletion_phase_finished',
        result: 'failed',
      }),
    );

    await jest.advanceTimersByTimeAsync(
      70_000 - WORKSPACE_DELETION_PHASE_TIMEOUT_MS,
    );
    await expect(outcome).resolves.toEqual({
      error: expect.objectContaining({
        code: 'WORKSPACE_DELETION_PHASE_TIMEOUT',
      }),
    });
    expect(trace.record).toHaveBeenLastCalledWith(
      expect.objectContaining({
        event: 'workspace_deletion_phase_finished',
        result: 'failed',
      }),
    );
  });
});
