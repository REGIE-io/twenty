import { WorkspaceActivationStatus } from 'twenty-shared/workspace';

import { WorkspaceDeletionLifecycleService } from 'src/engine/workspace-manager/workspace-cleaner/services/workspace-deletion-lifecycle.service';
import {
  type WorkspaceDeletionLifecycle,
  WorkspaceDeletionKind,
  WorkspaceDeletionPhase,
} from 'src/engine/core-modules/workspace/types/workspace-deletion-lifecycle.type';

describe('WorkspaceDeletionLifecycleService', () => {
  const workspaceId = '20202020-0000-4000-8000-000000000001';
  const requestedAt = new Date('2026-09-01T00:00:00.000Z');
  const claimedAt = new Date('2026-09-01T00:01:00.000Z');
  const staleAfterMs = 30_000;
  const service = new WorkspaceDeletionLifecycleService();

  const makeWorkspace = (
    overrides: Partial<WorkspaceDeletionLifecycle> = {},
  ): WorkspaceDeletionLifecycle => ({
    workspaceId,
    activationStatus: WorkspaceActivationStatus.SUSPENDED,
    deletionKind: null,
    deletionPhase: null,
    deletionRequestedAt: null,
    deletionLastProgressAt: null,
    deletionAttemptCount: 0,
    deletionLastErrorCode: null,
    deletionLastErrorMessage: null,
    ...overrides,
  });

  const makePendingWorkspace = (): WorkspaceDeletionLifecycle =>
    makeWorkspace({
      activationStatus: WorkspaceActivationStatus.PENDING_DELETION,
      deletionKind: WorkspaceDeletionKind.E2E,
      deletionPhase: WorkspaceDeletionPhase.MEMBERS,
      deletionRequestedAt: requestedAt,
      deletionLastProgressAt: requestedAt,
    });

  const makeOngoingWorkspace = (
    overrides: Partial<WorkspaceDeletionLifecycle> = {},
  ): WorkspaceDeletionLifecycle => ({
    ...makePendingWorkspace(),
    activationStatus: WorkspaceActivationStatus.ONGOING_DELETION,
    deletionLastProgressAt: claimedAt,
    deletionAttemptCount: 1,
    ...overrides,
  });

  it('admits an eligible workspace into deletion with MEMBERS as its persisted next phase', () => {
    expect(
      service.requestDeletion(
        makeWorkspace(),
        WorkspaceDeletionKind.E2E,
        requestedAt,
      ),
    ).toEqual(makePendingWorkspace());
  });

  it('refuses to move an active workspace directly into the destructive lifecycle', () => {
    expect(() =>
      service.requestDeletion(
        makeWorkspace({
          activationStatus: WorkspaceActivationStatus.ACTIVE,
        }),
        WorkspaceDeletionKind.E2E,
        requestedAt,
      ),
    ).toThrow('Workspace must be quarantined before deletion can be requested');
  });

  it('claims a pending deletion exactly once and increments its attempt count', () => {
    expect(
      service.claimDeletion(makePendingWorkspace(), claimedAt, staleAfterMs),
    ).toEqual(makeOngoingWorkspace());
  });

  it('does not steal a fresh claim but reclaims a stale claim at the same phase', () => {
    const ongoing = makeOngoingWorkspace();

    expect(
      service.claimDeletion(
        ongoing,
        new Date(claimedAt.getTime() + staleAfterMs - 1),
        staleAfterMs,
      ),
    ).toBeNull();
    expect(
      service.claimDeletion(
        ongoing,
        new Date(claimedAt.getTime() + staleAfterMs),
        staleAfterMs,
      ),
    ).toEqual({
      ...ongoing,
      deletionAttemptCount: 2,
      deletionLastProgressAt: new Date(claimedAt.getTime() + staleAfterMs),
    });
  });

  it('checkpoints only the current phase and never moves deletion backwards', () => {
    const afterMembers = service.completePhase(
      makeOngoingWorkspace(),
      WorkspaceDeletionPhase.MEMBERS,
      new Date('2026-09-01T00:02:00.000Z'),
    );

    expect(afterMembers).toEqual(
      makeOngoingWorkspace({
        deletionPhase: WorkspaceDeletionPhase.METADATA,
        deletionLastProgressAt: new Date('2026-09-01T00:02:00.000Z'),
      }),
    );
    expect(() =>
      service.completePhase(
        afterMembers!,
        WorkspaceDeletionPhase.MEMBERS,
        new Date('2026-09-01T00:03:00.000Z'),
      ),
    ).toThrow('Only the persisted next phase can be completed');
  });

  it('preserves the failed phase and becomes terminal when attempts are exhausted', () => {
    const failed = service.recordFailure(
      makeOngoingWorkspace({
        deletionPhase: WorkspaceDeletionPhase.SCHEMA,
        deletionAttemptCount: 3,
      }),
      'QUERY_TIMEOUT',
      'injected schema timeout',
      3,
    );

    expect(failed).toEqual(
      makeOngoingWorkspace({
        activationStatus: WorkspaceActivationStatus.DELETION_FAILED,
        deletionPhase: WorkspaceDeletionPhase.SCHEMA,
        deletionAttemptCount: 3,
        deletionLastErrorCode: 'QUERY_TIMEOUT',
        deletionLastErrorMessage: 'injected schema timeout',
      }),
    );
  });

  it('allows a failed deletion to be retried without losing its checkpoint', () => {
    const failed = makeOngoingWorkspace({
      activationStatus: WorkspaceActivationStatus.DELETION_FAILED,
      deletionPhase: WorkspaceDeletionPhase.EXTERNAL_CLEANUP,
      deletionAttemptCount: 3,
      deletionLastErrorCode: 'DNS_TIMEOUT',
      deletionLastErrorMessage: 'injected DNS timeout',
    });
    const retriedAt = new Date('2026-09-01T01:00:00.000Z');

    expect(service.retryFailedDeletion(failed, retriedAt)).toEqual({
      ...failed,
      activationStatus: WorkspaceActivationStatus.PENDING_DELETION,
      deletionLastProgressAt: retriedAt,
      deletionLastErrorCode: null,
      deletionLastErrorMessage: null,
    });
  });

  it.each(Object.values(WorkspaceDeletionPhase))(
    'eventually completes after interruption at %s',
    (interruptedPhase) => {
      let workspace: WorkspaceDeletionLifecycle | null = service.claimDeletion(
        makePendingWorkspace(),
        claimedAt,
        staleAfterMs,
      );
      let injectedFailure = false;

      while (workspace !== null) {
        if (workspace.deletionPhase === interruptedPhase && !injectedFailure) {
          workspace = service.recordFailure(
            workspace,
            'INJECTED_FAILURE',
            `interrupted at ${interruptedPhase}`,
            3,
          );
          workspace = service.claimDeletion(
            workspace,
            new Date(
              workspace.deletionLastProgressAt!.getTime() + staleAfterMs,
            ),
            staleAfterMs,
          );
          injectedFailure = true;
          continue;
        }

        workspace = service.completePhase(
          workspace,
          workspace.deletionPhase!,
          new Date(workspace.deletionLastProgressAt!.getTime() + 1),
        );
      }

      expect(injectedFailure).toBe(true);
      expect(workspace).toBeNull();
    },
  );
});
