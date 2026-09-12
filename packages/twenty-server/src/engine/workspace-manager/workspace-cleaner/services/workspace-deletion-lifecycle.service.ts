import {
  type WorkspaceDeletionLifecycle,
  type WorkspaceDeletionKind,
  type WorkspaceDeletionPhase,
} from 'src/engine/workspace-manager/workspace-cleaner/types/workspace-deletion-lifecycle.type';

export class WorkspaceDeletionLifecycleService {
  requestDeletion(
    _workspace: WorkspaceDeletionLifecycle,
    _kind: WorkspaceDeletionKind,
    _now: Date,
  ): WorkspaceDeletionLifecycle {
    throw new Error('Workspace deletion lifecycle is not implemented');
  }

  claimDeletion(
    _workspace: WorkspaceDeletionLifecycle,
    _now: Date,
    _staleAfterMs: number,
  ): WorkspaceDeletionLifecycle | null {
    throw new Error('Workspace deletion lifecycle is not implemented');
  }

  completePhase(
    _workspace: WorkspaceDeletionLifecycle,
    _completedPhase: WorkspaceDeletionPhase,
    _now: Date,
  ): WorkspaceDeletionLifecycle | null {
    throw new Error('Workspace deletion lifecycle is not implemented');
  }

  recordFailure(
    _workspace: WorkspaceDeletionLifecycle,
    _errorCode: string,
    _errorMessage: string,
    _maxAttempts: number,
  ): WorkspaceDeletionLifecycle {
    throw new Error('Workspace deletion lifecycle is not implemented');
  }

  retryFailedDeletion(
    _workspace: WorkspaceDeletionLifecycle,
    _now: Date,
  ): WorkspaceDeletionLifecycle {
    throw new Error('Workspace deletion lifecycle is not implemented');
  }
}
