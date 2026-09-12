import { type WorkspaceDeletionCoordinatorService } from 'src/engine/workspace-manager/workspace-cleaner/services/workspace-deletion-coordinator.service';
import { type WorkspaceDeletionPhaseRunnersService } from 'src/engine/workspace-manager/workspace-cleaner/services/workspace-deletion-phase-runners.service';
import { type WorkspaceDeletionTraceService } from 'src/engine/workspace-manager/workspace-cleaner/services/workspace-deletion-trace.service';
import { WorkspaceDeletionJob } from 'src/engine/workspace-manager/workspace-cleaner/jobs/workspace-deletion.job';

describe('WorkspaceDeletionJob', () => {
  const workspaceId = '20202020-0000-4000-8000-000000000001';
  const runners = {};
  const coordinator = { execute: jest.fn() };
  const phaseRunners = { build: jest.fn(() => runners) };
  const trace = { record: jest.fn() };
  const job = () =>
    new WorkspaceDeletionJob(
      coordinator as unknown as WorkspaceDeletionCoordinatorService,
      phaseRunners as unknown as WorkspaceDeletionPhaseRunnersService,
      trace as unknown as WorkspaceDeletionTraceService,
    );

  beforeEach(() => jest.clearAllMocks());

  it('executes one workspace and leaves start and completion traces', async () => {
    coordinator.execute.mockResolvedValue({ status: 'completed' });

    await job().handle({ workspaceId });

    expect(coordinator.execute).toHaveBeenCalledWith(
      workspaceId,
      runners,
      expect.objectContaining({ staleAfterMs: 30_000, maxAttempts: 3 }),
    );
    expect(trace.record).toHaveBeenNthCalledWith(1, {
      event: 'workspace_deletion_started',
      workspaceId,
    });
    expect(trace.record).toHaveBeenNthCalledWith(2, {
      event: 'workspace_deletion_finished',
      workspaceId,
      result: 'completed',
    });
  });

  it('throws retryable results so the queue retry policy runs', async () => {
    coordinator.execute.mockResolvedValue({
      status: 'retryable-failure',
      error: new Error('schema lock timeout'),
    });

    await expect(job().handle({ workspaceId })).rejects.toThrow(
      'schema lock timeout',
    );
    expect(trace.record).toHaveBeenLastCalledWith({
      event: 'workspace_deletion_finished',
      workspaceId,
      result: 'retryable-failure',
    });
  });

  it.each(['busy', 'not-claimable', 'fenced', 'terminal-failure'])(
    'records %s without falsely throwing a retry',
    async (status) => {
      coordinator.execute.mockResolvedValue({ status });

      await expect(job().handle({ workspaceId })).resolves.toBeUndefined();
      expect(trace.record).toHaveBeenLastCalledWith({
        event: 'workspace_deletion_finished',
        workspaceId,
        result: status,
      });
    },
  );
});
