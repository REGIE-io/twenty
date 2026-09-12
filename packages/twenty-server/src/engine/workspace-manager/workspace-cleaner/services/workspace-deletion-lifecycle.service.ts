import { WorkspaceActivationStatus } from 'twenty-shared/workspace';

import {
  type WorkspaceDeletionLifecycle,
  type WorkspaceDeletionKind,
  type WorkspaceDeletionPhase,
  WORKSPACE_DELETION_PHASES,
} from 'src/engine/workspace-manager/workspace-cleaner/types/workspace-deletion-lifecycle.type';

export class WorkspaceDeletionLifecycleService {
  requestDeletion(
    workspace: WorkspaceDeletionLifecycle,
    kind: WorkspaceDeletionKind,
    now: Date,
  ): WorkspaceDeletionLifecycle {
    if (workspace.activationStatus !== WorkspaceActivationStatus.SUSPENDED) {
      throw new Error(
        'Workspace must be quarantined before deletion can be requested',
      );
    }

    return {
      ...workspace,
      activationStatus: WorkspaceActivationStatus.PENDING_DELETION,
      deletionKind: kind,
      deletionPhase: WORKSPACE_DELETION_PHASES[0],
      deletionRequestedAt: now,
      deletionLastProgressAt: now,
      deletionAttemptCount: 0,
      deletionLastErrorCode: null,
      deletionLastErrorMessage: null,
    };
  }

  claimDeletion(
    workspace: WorkspaceDeletionLifecycle,
    now: Date,
    staleAfterMs: number,
  ): WorkspaceDeletionLifecycle | null {
    const isPending =
      workspace.activationStatus === WorkspaceActivationStatus.PENDING_DELETION;
    const isStaleOngoing =
      workspace.activationStatus ===
        WorkspaceActivationStatus.ONGOING_DELETION &&
      workspace.deletionLastProgressAt !== null &&
      now.getTime() - workspace.deletionLastProgressAt.getTime() >=
        staleAfterMs;

    if (!isPending && !isStaleOngoing) {
      return null;
    }

    return {
      ...workspace,
      activationStatus: WorkspaceActivationStatus.ONGOING_DELETION,
      deletionLastProgressAt: now,
      deletionAttemptCount: workspace.deletionAttemptCount + 1,
    };
  }

  completePhase(
    workspace: WorkspaceDeletionLifecycle,
    completedPhase: WorkspaceDeletionPhase,
    now: Date,
  ): WorkspaceDeletionLifecycle | null {
    if (
      workspace.activationStatus !==
        WorkspaceActivationStatus.ONGOING_DELETION ||
      workspace.deletionPhase !== completedPhase
    ) {
      throw new Error('Only the persisted next phase can be completed');
    }

    const phaseIndex = WORKSPACE_DELETION_PHASES.indexOf(completedPhase);
    const nextPhase = WORKSPACE_DELETION_PHASES[phaseIndex + 1];

    if (nextPhase === undefined) {
      return null;
    }

    return {
      ...workspace,
      deletionPhase: nextPhase,
      deletionLastProgressAt: now,
      deletionLastErrorCode: null,
      deletionLastErrorMessage: null,
    };
  }

  recordFailure(
    workspace: WorkspaceDeletionLifecycle,
    errorCode: string,
    errorMessage: string,
    maxAttempts: number,
  ): WorkspaceDeletionLifecycle {
    if (
      workspace.activationStatus !== WorkspaceActivationStatus.ONGOING_DELETION
    ) {
      throw new Error('Only an ongoing deletion can record a failure');
    }

    return {
      ...workspace,
      activationStatus:
        workspace.deletionAttemptCount >= maxAttempts
          ? WorkspaceActivationStatus.DELETION_FAILED
          : workspace.activationStatus,
      deletionLastErrorCode: errorCode,
      deletionLastErrorMessage: errorMessage,
    };
  }

  retryFailedDeletion(
    workspace: WorkspaceDeletionLifecycle,
    now: Date,
  ): WorkspaceDeletionLifecycle {
    if (
      workspace.activationStatus !== WorkspaceActivationStatus.DELETION_FAILED
    ) {
      throw new Error('Only a failed deletion can be retried');
    }

    return {
      ...workspace,
      activationStatus: WorkspaceActivationStatus.PENDING_DELETION,
      deletionLastProgressAt: now,
      deletionLastErrorCode: null,
      deletionLastErrorMessage: null,
    };
  }
}
