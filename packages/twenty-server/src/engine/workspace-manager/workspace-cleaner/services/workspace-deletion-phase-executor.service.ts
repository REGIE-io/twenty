import { Injectable } from '@nestjs/common';

import { WorkspaceActivationStatus } from 'twenty-shared/workspace';

import {
  type WorkspaceDeletionLifecycle,
  WorkspaceDeletionPhase,
} from 'src/engine/core-modules/workspace/types/workspace-deletion-lifecycle.type';
import { WorkspaceDeletionLifecycleStore } from 'src/engine/workspace-manager/workspace-cleaner/services/workspace-deletion-lifecycle.store';

export type WorkspaceDeletionPhaseRunners = Record<
  WorkspaceDeletionPhase,
  (workspaceId: string) => Promise<void>
>;

export type WorkspaceDeletionExecutionResult =
  | { status: 'completed' }
  | { status: 'fenced' }
  | { status: 'retryable-failure' | 'terminal-failure'; error: unknown };

@Injectable()
export class WorkspaceDeletionPhaseExecutorService {
  constructor(
    private readonly lifecycleStore: WorkspaceDeletionLifecycleStore,
  ) {}

  async execute(
    initialClaim: WorkspaceDeletionLifecycle,
    runners: WorkspaceDeletionPhaseRunners,
    maxAttempts: number,
  ): Promise<WorkspaceDeletionExecutionResult> {
    let claim: WorkspaceDeletionLifecycle | null = initialClaim;

    while (claim !== null && claim.deletionPhase !== null) {
      const phase = claim.deletionPhase;
      const expectedAttempt = claim.deletionAttemptCount;

      try {
        await runners[phase](claim.workspaceId);
      } catch (error) {
        const recorded = await this.lifecycleStore.recordFailure(
          claim.workspaceId,
          phase,
          expectedAttempt,
          this.errorCode(error),
          this.errorMessage(error),
          maxAttempts,
        );

        if (recorded === null) {
          return { status: 'fenced' };
        }

        return {
          status:
            recorded.activationStatus ===
            WorkspaceActivationStatus.DELETION_FAILED
              ? 'terminal-failure'
              : 'retryable-failure',
          error,
        };
      }

      if (phase === WorkspaceDeletionPhase.CORE_ROW) {
        if (await this.lifecycleStore.isDeletionComplete(claim.workspaceId)) {
          return { status: 'completed' };
        }

        const completionError = new Error(
          'Core workspace row still exists after the CORE_ROW phase',
        );
        const recorded = await this.lifecycleStore.recordFailure(
          claim.workspaceId,
          phase,
          expectedAttempt,
          'CORE_ROW_STILL_PRESENT',
          completionError.message,
          maxAttempts,
        );

        if (recorded === null) {
          return { status: 'fenced' };
        }

        return {
          status:
            recorded.activationStatus ===
            WorkspaceActivationStatus.DELETION_FAILED
              ? 'terminal-failure'
              : 'retryable-failure',
          error: completionError,
        };
      }

      claim = await this.lifecycleStore.checkpointPhase(
        claim.workspaceId,
        phase,
        expectedAttempt,
        new Date(),
      );

      if (claim === null) {
        return { status: 'fenced' };
      }
    }

    return { status: 'fenced' };
  }

  private errorCode(error: unknown): string {
    return error instanceof Error && error.name
      ? error.name.toUpperCase()
      : 'UNKNOWN_ERROR';
  }

  private errorMessage(error: unknown): string {
    return error instanceof Error ? error.message : String(error);
  }
}
