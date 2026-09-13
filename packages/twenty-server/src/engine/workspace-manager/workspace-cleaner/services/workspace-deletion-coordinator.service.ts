import { Injectable } from '@nestjs/common';

import { PostgresAdvisoryLockService } from 'src/database/typeorm/postgres-advisory-lock.service';
import {
  type WorkspaceDeletionExecutionResult,
  type WorkspaceDeletionPhaseRunners,
  WorkspaceDeletionPhaseExecutorService,
} from 'src/engine/workspace-manager/workspace-cleaner/services/workspace-deletion-phase-executor.service';
import { WorkspaceDeletionLifecycleStore } from 'src/engine/workspace-manager/workspace-cleaner/services/workspace-deletion-lifecycle.store';

export type WorkspaceDeletionCoordinatorResult =
  | WorkspaceDeletionExecutionResult
  | { status: 'busy' }
  | { status: 'not-claimable' };

@Injectable()
export class WorkspaceDeletionCoordinatorService {
  constructor(
    private readonly advisoryLock: PostgresAdvisoryLockService,
    private readonly lifecycleStore: WorkspaceDeletionLifecycleStore,
    private readonly phaseExecutor: WorkspaceDeletionPhaseExecutorService,
  ) {}

  async execute(
    workspaceId: string,
    runners: WorkspaceDeletionPhaseRunners,
    options: { now: Date; staleAfterMs: number; maxAttempts: number },
  ): Promise<WorkspaceDeletionCoordinatorResult> {
    const locked = await this.advisoryLock.tryWithLock(
      `workspace-deletion:${workspaceId}`,
      async (): Promise<WorkspaceDeletionCoordinatorResult> => {
        const claim = await this.lifecycleStore.claimDeletion(
          workspaceId,
          options.now,
          options.staleAfterMs,
        );

        if (claim === null) {
          return { status: 'not-claimable' };
        }

        return this.phaseExecutor.execute(claim, runners, options.maxAttempts);
      },
    );

    return locked.acquired ? locked.value : { status: 'busy' };
  }
}
