import { type DataSource } from 'typeorm';

import { WorkspaceActivationStatus } from 'twenty-shared/workspace';

import {
  WorkspaceDeletionKind,
  WorkspaceDeletionPhase,
} from 'src/engine/core-modules/workspace/types/workspace-deletion-lifecycle.type';
import { WorkspaceDeletionLifecycleStore } from 'src/engine/workspace-manager/workspace-cleaner/services/workspace-deletion-lifecycle.store';

describe('WorkspaceDeletionLifecycleStore', () => {
  const workspaceId = '20202020-0000-4000-8000-000000000001';
  const now = new Date('2026-09-02T00:00:00.000Z');

  it('requests deletion only from the quarantined state', async () => {
    const query = jest.fn().mockResolvedValue([[], 0]);
    const store = new WorkspaceDeletionLifecycleStore({
      query,
    } as unknown as DataSource);

    await expect(
      store.requestDeletion(workspaceId, WorkspaceDeletionKind.E2E, now),
    ).resolves.toBeNull();

    expect(query).toHaveBeenCalledWith(
      expect.stringContaining('AND "activationStatus" = $6'),
      [
        workspaceId,
        WorkspaceActivationStatus.PENDING_DELETION,
        WorkspaceDeletionKind.E2E,
        WorkspaceDeletionPhase.MEMBERS,
        now,
        WorkspaceActivationStatus.SUSPENDED,
      ],
    );
  });

  it('uses a separate atomic transition for explicit instant hard deletion', async () => {
    const query = jest.fn().mockResolvedValue([[], 0]);
    const store = new WorkspaceDeletionLifecycleStore({
      query,
    } as unknown as DataSource);

    await store.requestInstantHardDeletion(
      workspaceId,
      WorkspaceDeletionKind.E2E,
      now,
    );

    expect(query).toHaveBeenCalledWith(
      expect.stringContaining('"activationStatus" IN ($6, $7)'),
      [
        workspaceId,
        WorkspaceActivationStatus.PENDING_DELETION,
        WorkspaceDeletionKind.E2E,
        WorkspaceDeletionPhase.MEMBERS,
        now,
        WorkspaceActivationStatus.ACTIVE,
        WorkspaceActivationStatus.SUSPENDED,
      ],
    );
  });

  it('uses one conditional update to claim pending or stale work', async () => {
    const query = jest.fn().mockResolvedValue([
      [
        {
          workspaceId,
          activationStatus: WorkspaceActivationStatus.ONGOING_DELETION,
          deletionKind: WorkspaceDeletionKind.E2E,
          deletionPhase: WorkspaceDeletionPhase.METADATA,
          deletionRequestedAt: now,
          deletionLastProgressAt: now,
          deletionAttemptCount: '2',
          deletionLastErrorCode: null,
          deletionLastErrorMessage: null,
        },
      ],
      1,
    ]);
    const store = new WorkspaceDeletionLifecycleStore({
      query,
    } as unknown as DataSource);

    await expect(
      store.claimDeletion(workspaceId, now, 30_000),
    ).resolves.toMatchObject({
      workspaceId,
      activationStatus: WorkspaceActivationStatus.ONGOING_DELETION,
      deletionPhase: WorkspaceDeletionPhase.METADATA,
      deletionAttemptCount: 2,
    });

    const [sql, parameters] = query.mock.calls[0];

    expect(sql).toContain('UPDATE "core"."workspace"');
    expect(sql).toContain('"deletionAttemptCount" + 1');
    expect(sql).toContain('"deletionLastProgressAt" <= $5');
    expect(parameters).toEqual([
      workspaceId,
      WorkspaceActivationStatus.ONGOING_DELETION,
      now,
      WorkspaceActivationStatus.PENDING_DELETION,
      new Date('2026-09-01T23:59:30.000Z'),
    ]);
  });
});
