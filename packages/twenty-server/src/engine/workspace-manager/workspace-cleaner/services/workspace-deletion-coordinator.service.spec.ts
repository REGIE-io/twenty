import { type PostgresAdvisoryLockService } from 'src/database/typeorm/postgres-advisory-lock.service';
import { type WorkspaceDeletionPhaseRunners } from 'src/engine/workspace-manager/workspace-cleaner/services/workspace-deletion-phase-executor.service';
import { type WorkspaceDeletionPhaseExecutorService } from 'src/engine/workspace-manager/workspace-cleaner/services/workspace-deletion-phase-executor.service';
import { WorkspaceDeletionCoordinatorService } from 'src/engine/workspace-manager/workspace-cleaner/services/workspace-deletion-coordinator.service';
import { type WorkspaceDeletionLifecycleStore } from 'src/engine/workspace-manager/workspace-cleaner/services/workspace-deletion-lifecycle.store';

describe('WorkspaceDeletionCoordinatorService concurrency', () => {
  const firstWorkspaceId = '20202020-0000-4000-8000-000000000001';
  const secondWorkspaceId = '20202020-0000-4000-8000-000000000002';
  const runners = {} as WorkspaceDeletionPhaseRunners;

  const makeLock = () => {
    const held = new Set<string>();

    return {
      tryWithLock: jest.fn(
        async (key: string, callback: () => Promise<unknown>) => {
          if (held.has(key)) {
            return { acquired: false } as const;
          }
          held.add(key);
          try {
            return { acquired: true, value: await callback() } as const;
          } finally {
            held.delete(key);
          }
        },
      ),
    } as unknown as PostgresAdvisoryLockService;
  };

  const deferred = () => {
    let resolve!: () => void;
    const promise = new Promise<void>((done) => (resolve = done));

    return { promise, resolve };
  };

  it('runs only one executor for the same workspace at a time', async () => {
    const release = deferred();
    const entered = deferred();
    const store = {
      claimDeletion: jest
        .fn()
        .mockResolvedValue({ workspaceId: firstWorkspaceId }),
    } as unknown as WorkspaceDeletionLifecycleStore;
    const executor = {
      execute: jest.fn(async () => {
        entered.resolve();
        await release.promise;
        return { status: 'completed' } as const;
      }),
    } as unknown as WorkspaceDeletionPhaseExecutorService;
    const coordinator = new WorkspaceDeletionCoordinatorService(
      makeLock(),
      store,
      executor,
    );

    const first = coordinator.execute(firstWorkspaceId, runners, {
      now: new Date(),
      staleAfterMs: 30_000,
      maxAttempts: 3,
    });
    await entered.promise;
    await expect(
      coordinator.execute(firstWorkspaceId, runners, {
        now: new Date(),
        staleAfterMs: 30_000,
        maxAttempts: 3,
      }),
    ).resolves.toEqual({ status: 'busy' });
    release.resolve();
    await expect(first).resolves.toEqual({ status: 'completed' });
    expect(executor.execute).toHaveBeenCalledTimes(1);
  });

  it('allows different workspaces to execute concurrently', async () => {
    const bothEntered = deferred();
    const release = deferred();
    const entered = new Set<string>();
    const store = {
      claimDeletion: jest.fn(async (workspaceId: string) => ({ workspaceId })),
    } as unknown as WorkspaceDeletionLifecycleStore;
    const executor = {
      execute: jest.fn(async (claim: { workspaceId: string }) => {
        entered.add(claim.workspaceId);
        if (entered.size === 2) bothEntered.resolve();
        await release.promise;
        return { status: 'completed' } as const;
      }),
    } as unknown as WorkspaceDeletionPhaseExecutorService;
    const coordinator = new WorkspaceDeletionCoordinatorService(
      makeLock(),
      store,
      executor,
    );

    const executions = [firstWorkspaceId, secondWorkspaceId].map(
      (workspaceId) =>
        coordinator.execute(workspaceId, runners, {
          now: new Date(),
          staleAfterMs: 30_000,
          maxAttempts: 3,
        }),
    );
    await bothEntered.promise;
    expect(entered).toEqual(new Set([firstWorkspaceId, secondWorkspaceId]));
    release.resolve();
    await expect(Promise.all(executions)).resolves.toEqual([
      { status: 'completed' },
      { status: 'completed' },
    ]);
  });
});
