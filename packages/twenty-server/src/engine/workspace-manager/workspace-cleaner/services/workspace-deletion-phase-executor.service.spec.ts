import { WorkspaceActivationStatus } from 'twenty-shared/workspace';

import {
  type WorkspaceDeletionLifecycle,
  WorkspaceDeletionKind,
  WorkspaceDeletionPhase,
  WORKSPACE_DELETION_PHASES,
} from 'src/engine/core-modules/workspace/types/workspace-deletion-lifecycle.type';
import {
  WorkspaceDeletionPhaseExecutorService,
  type WorkspaceDeletionPhaseRunners,
} from 'src/engine/workspace-manager/workspace-cleaner/services/workspace-deletion-phase-executor.service';
import { type WorkspaceDeletionLifecycleStore } from 'src/engine/workspace-manager/workspace-cleaner/services/workspace-deletion-lifecycle.store';

describe('WorkspaceDeletionPhaseExecutorService', () => {
  const workspaceId = '20202020-0000-4000-8000-000000000001';

  const claim = (
    phase: WorkspaceDeletionPhase,
  ): WorkspaceDeletionLifecycle => ({
    workspaceId,
    activationStatus: WorkspaceActivationStatus.ONGOING_DELETION,
    deletionKind: WorkspaceDeletionKind.E2E,
    deletionPhase: phase,
    deletionRequestedAt: new Date('2026-09-01T00:00:00.000Z'),
    deletionLastProgressAt: new Date('2026-09-01T00:01:00.000Z'),
    deletionAttemptCount: 2,
    deletionLastErrorCode: null,
    deletionLastErrorMessage: null,
  });

  const makeRunners = () =>
    Object.fromEntries(
      WORKSPACE_DELETION_PHASES.map((phase) => [phase, jest.fn()]),
    ) as WorkspaceDeletionPhaseRunners;

  it('starts at the persisted phase and runs only the remaining phases', async () => {
    const completed: WorkspaceDeletionPhase[] = [];
    const store = {
      checkpointPhase: jest.fn(
        async (_id: string, phase: WorkspaceDeletionPhase) => {
          completed.push(phase);
          const next =
            WORKSPACE_DELETION_PHASES[
              WORKSPACE_DELETION_PHASES.indexOf(phase) + 1
            ];

          return next === undefined ? null : claim(next);
        },
      ),
      recordFailure: jest.fn(),
      isDeletionComplete: jest.fn().mockResolvedValue(true),
    } as unknown as WorkspaceDeletionLifecycleStore;
    const runners = makeRunners();

    await expect(
      new WorkspaceDeletionPhaseExecutorService(store).execute(
        claim(WorkspaceDeletionPhase.SCHEMA),
        runners,
        3,
      ),
    ).resolves.toEqual({
      status: 'completed',
      deletionKind: WorkspaceDeletionKind.E2E,
    });

    expect(runners.MEMBERS).not.toHaveBeenCalled();
    expect(runners.METADATA).not.toHaveBeenCalled();
    for (const phase of [
      WorkspaceDeletionPhase.SCHEMA,
      WorkspaceDeletionPhase.CACHE,
      WorkspaceDeletionPhase.EXTERNAL_CLEANUP,
      WorkspaceDeletionPhase.CORE_ROW,
    ]) {
      expect(runners[phase]).toHaveBeenCalledWith(workspaceId);
    }
    expect(completed).toEqual([
      WorkspaceDeletionPhase.SCHEMA,
      WorkspaceDeletionPhase.CACHE,
      WorkspaceDeletionPhase.EXTERNAL_CLEANUP,
    ]);
  });

  it('records the exact failed phase and does not run later phases', async () => {
    const failure = new Error('injected schema timeout');
    const store = {
      checkpointPhase: jest.fn(),
      isDeletionComplete: jest.fn(),
      recordFailure: jest.fn().mockResolvedValue({
        ...claim(WorkspaceDeletionPhase.SCHEMA),
        deletionLastErrorCode: 'ERROR',
      }),
    } as unknown as WorkspaceDeletionLifecycleStore;
    const runners = makeRunners();

    (runners.SCHEMA as jest.Mock).mockRejectedValue(failure);

    await expect(
      new WorkspaceDeletionPhaseExecutorService(store).execute(
        claim(WorkspaceDeletionPhase.SCHEMA),
        runners,
        3,
      ),
    ).resolves.toEqual({
      status: 'retryable-failure',
      error: failure,
      deletionKind: WorkspaceDeletionKind.E2E,
      phase: WorkspaceDeletionPhase.SCHEMA,
      attempt: 2,
      errorCode: 'ERROR',
    });
    expect(store.recordFailure).toHaveBeenCalledWith(
      workspaceId,
      WorkspaceDeletionPhase.SCHEMA,
      2,
      'ERROR',
      failure.message,
      3,
    );
    expect(runners.CACHE).not.toHaveBeenCalled();
  });

  it('stops when its checkpoint is fenced by a newer attempt', async () => {
    const store = {
      checkpointPhase: jest.fn().mockResolvedValue(null),
      recordFailure: jest.fn(),
      isDeletionComplete: jest.fn(),
    } as unknown as WorkspaceDeletionLifecycleStore;
    const runners = makeRunners();

    await expect(
      new WorkspaceDeletionPhaseExecutorService(store).execute(
        claim(WorkspaceDeletionPhase.MEMBERS),
        runners,
        3,
      ),
    ).resolves.toEqual({ status: 'fenced' });
    expect(runners.MEMBERS).toHaveBeenCalledTimes(1);
    expect(runners.METADATA).not.toHaveBeenCalled();
  });

  it('does not report completion when the core row runner leaves the workspace row present', async () => {
    const store = {
      checkpointPhase: jest.fn(),
      isDeletionComplete: jest.fn().mockResolvedValue(false),
      recordFailure: jest
        .fn()
        .mockResolvedValue(claim(WorkspaceDeletionPhase.CORE_ROW)),
    } as unknown as WorkspaceDeletionLifecycleStore;
    const runners = makeRunners();

    await expect(
      new WorkspaceDeletionPhaseExecutorService(store).execute(
        claim(WorkspaceDeletionPhase.CORE_ROW),
        runners,
        3,
      ),
    ).resolves.toMatchObject({ status: 'retryable-failure' });
    expect(store.isDeletionComplete).toHaveBeenCalledWith(workspaceId);
    expect(store.recordFailure).toHaveBeenCalledWith(
      workspaceId,
      WorkspaceDeletionPhase.CORE_ROW,
      2,
      'CORE_ROW_STILL_PRESENT',
      'Core workspace row still exists after the CORE_ROW phase',
      3,
    );
  });

  it('reports completion only after the core workspace row is absent', async () => {
    const store = {
      checkpointPhase: jest.fn(),
      isDeletionComplete: jest.fn().mockResolvedValue(true),
      recordFailure: jest.fn(),
    } as unknown as WorkspaceDeletionLifecycleStore;
    const runners = makeRunners();

    await expect(
      new WorkspaceDeletionPhaseExecutorService(store).execute(
        claim(WorkspaceDeletionPhase.CORE_ROW),
        runners,
        3,
      ),
    ).resolves.toEqual({
      status: 'completed',
      deletionKind: WorkspaceDeletionKind.E2E,
    });
    expect(store.recordFailure).not.toHaveBeenCalled();
  });
});
