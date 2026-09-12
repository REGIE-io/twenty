import { type ExceptionHandlerService } from 'src/engine/core-modules/exception-handler/exception-handler.service';
import { type MetricsService } from 'src/engine/core-modules/metrics/metrics.service';
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
  const metrics = { incrementCounterForEvent: jest.fn() };
  const exceptionHandler = { captureExceptions: jest.fn() };
  const job = () =>
    Reflect.construct(WorkspaceDeletionJob, [
      coordinator as unknown as WorkspaceDeletionCoordinatorService,
      phaseRunners as unknown as WorkspaceDeletionPhaseRunnersService,
      trace as unknown as WorkspaceDeletionTraceService,
      metrics as unknown as MetricsService,
      exceptionHandler as unknown as ExceptionHandlerService,
    ]);

  beforeEach(() => jest.clearAllMocks());

  it('executes one workspace and leaves start and completion traces', async () => {
    coordinator.execute.mockResolvedValue({
      status: 'completed',
      deletionKind: 'E2E',
    });

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
    expect(metrics.incrementCounterForEvent).toHaveBeenCalledWith({
      key: 'workspace-deletion/completed',
      attributes: { deletionKind: 'E2E' },
      shouldStoreInCache: false,
    });
    expect(exceptionHandler.captureExceptions).not.toHaveBeenCalled();
  });

  it('throws retryable results so the queue retry policy runs', async () => {
    const timeout = Object.assign(new Error('schema lock timeout'), {
      code: '55P03',
    });

    coordinator.execute.mockResolvedValue({
      status: 'retryable-failure',
      error: timeout,
      deletionKind: 'E2E',
      phase: 'SCHEMA',
      attempt: 1,
      errorCode: '55P03',
    });

    await expect(job().handle({ workspaceId })).rejects.toThrow(
      'schema lock timeout',
    );
    expect(trace.record).toHaveBeenLastCalledWith({
      event: 'workspace_deletion_failed',
      workspaceId,
      result: 'retryable-failure',
      deletionKind: 'E2E',
      phase: 'SCHEMA',
      attempt: 1,
      errorCode: '55P03',
      errorMessage: 'schema lock timeout',
    });
    expect(metrics.incrementCounterForEvent).toHaveBeenCalledWith({
      key: 'workspace-deletion/failed',
      attributes: {
        deletionKind: 'E2E',
        phase: 'SCHEMA',
        result: 'retryable-failure',
        errorCode: '55P03',
      },
      shouldStoreInCache: false,
    });
    expect(exceptionHandler.captureExceptions).toHaveBeenCalledWith([timeout], {
      workspace: { id: workspaceId },
      additionalData: {
        deletionKind: 'E2E',
        phase: 'SCHEMA',
        attempt: 1,
        result: 'retryable-failure',
        errorCode: '55P03',
      },
    });
  });

  it('reports a terminal failure even though it does not throw for a queue retry', async () => {
    const failure = Object.assign(new Error('invalid E2E marker'), {
      code: 'INVALID_MARKER',
    });

    coordinator.execute.mockResolvedValue({
      status: 'terminal-failure',
      error: failure,
      deletionKind: 'E2E',
      phase: 'MEMBERS',
      attempt: 3,
      errorCode: 'INVALID_MARKER',
    });

    await expect(job().handle({ workspaceId })).resolves.toBeUndefined();

    expect(exceptionHandler.captureExceptions).toHaveBeenCalledWith(
      [failure],
      expect.objectContaining({ workspace: { id: workspaceId } }),
    );
    expect(metrics.incrementCounterForEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        key: 'workspace-deletion/failed',
        attributes: expect.objectContaining({
          result: 'terminal-failure',
          errorCode: 'INVALID_MARKER',
        }),
      }),
    );
  });

  it.each(['busy', 'not-claimable', 'fenced'])(
    'records %s without falsely throwing a retry',
    async (status) => {
      coordinator.execute.mockResolvedValue({ status });

      await expect(job().handle({ workspaceId })).resolves.toBeUndefined();
      expect(trace.record).toHaveBeenLastCalledWith({
        event: 'workspace_deletion_finished',
        workspaceId,
        result: status,
      });
      expect(metrics.incrementCounterForEvent).not.toHaveBeenCalledWith(
        expect.objectContaining({ key: 'workspace-deletion/completed' }),
      );
    },
  );
});
