import { BadRequestException, ConflictException } from '@nestjs/common';
import { WorkspaceActivationStatus } from 'twenty-shared/workspace';

import {
  WorkspaceDeletionKind,
  WorkspaceDeletionPhase,
} from 'src/engine/core-modules/workspace/types/workspace-deletion-lifecycle.type';
import { InternalWorkspaceInstantHardDeletionService } from 'src/engine/workspace-manager/workspace-cleaner/services/internal-workspace-instant-hard-deletion.service';

describe('InternalWorkspaceInstantHardDeletionService', () => {
  const workspaceId = '20202020-0000-4000-8000-000000000001';
  const input = {
    organizationId: 'org_e2e_run_1',
    workspaceSlug: 'org-e2e-run-1',
  };
  const pending = {
    workspaceId,
    activationStatus: WorkspaceActivationStatus.PENDING_DELETION,
    deletionKind: WorkspaceDeletionKind.E2E,
    deletionPhase: WorkspaceDeletionPhase.MEMBERS,
    deletionRequestedAt: new Date('2026-09-12T12:00:00.000Z'),
    deletionLastProgressAt: new Date('2026-09-12T12:00:00.000Z'),
    deletionAttemptCount: 0,
    deletionLastErrorCode: null,
    deletionLastErrorMessage: null,
  };

  const makeService = () => {
    const workspaceRepository = {
      findOne: jest.fn().mockResolvedValue({
        id: workspaceId,
        subdomain: input.workspaceSlug,
        activationStatus: WorkspaceActivationStatus.ACTIVE,
        deletionKind: null,
      }),
    };
    const markerRepository = {
      findOne: jest.fn().mockResolvedValue({
        value: {
          ephemeral: true,
          ...input,
          workspaceSlug: input.workspaceSlug,
        },
      }),
    };
    const store = {
      requestInstantHardDeletion: jest.fn().mockResolvedValue(pending),
    };
    const queue = { enqueue: jest.fn().mockResolvedValue(undefined) };
    const service = new InternalWorkspaceInstantHardDeletionService(
      workspaceRepository as never,
      markerRepository as never,
      store as never,
      queue as never,
    );

    return { service, workspaceRepository, markerRepository, store, queue };
  };

  it('atomically admits and queues a marked workspace for instant hard deletion', async () => {
    const { service, store, queue } = makeService();

    await expect(service.request(workspaceId, input)).resolves.toMatchObject({
      operation: 'instant-hard-deletion',
      workspaceId,
      status: WorkspaceActivationStatus.PENDING_DELETION,
      phase: WorkspaceDeletionPhase.MEMBERS,
      completed: false,
    });
    expect(store.requestInstantHardDeletion).toHaveBeenCalledWith(
      workspaceId,
      WorkspaceDeletionKind.E2E,
      expect.any(Date),
    );
    expect(queue.enqueue).toHaveBeenCalledWith({
      workspaceId,
      jobId: `workspace-delete:${workspaceId}`,
    });
  });

  it('returns and re-enqueues the same pending operation on a repeated request', async () => {
    const { service, workspaceRepository, store, queue } = makeService();
    store.requestInstantHardDeletion.mockResolvedValue(null);
    workspaceRepository.findOne
      .mockResolvedValueOnce({
        id: workspaceId,
        subdomain: input.workspaceSlug,
        activationStatus: WorkspaceActivationStatus.ACTIVE,
        deletionKind: null,
      })
      .mockResolvedValueOnce({ ...pending, id: workspaceId });

    await expect(service.request(workspaceId, input)).resolves.toMatchObject({
      operation: 'instant-hard-deletion',
      status: WorkspaceActivationStatus.PENDING_DELETION,
      phase: WorkspaceDeletionPhase.MEMBERS,
    });
    expect(queue.enqueue).toHaveBeenCalledTimes(1);
  });

  it('refuses mismatched safety identity before changing lifecycle state', async () => {
    const { service, markerRepository, store, queue } = makeService();
    markerRepository.findOne.mockResolvedValue({
      value: {
        ephemeral: true,
        organizationId: 'org_e2e_someone_else',
        workspaceSlug: input.workspaceSlug,
      },
    });

    await expect(service.request(workspaceId, input)).rejects.toThrow(
      BadRequestException,
    );
    expect(store.requestInstantHardDeletion).not.toHaveBeenCalled();
    expect(queue.enqueue).not.toHaveBeenCalled();
  });

  it('refuses to reuse an existing non-E2E deletion operation', async () => {
    const { service, workspaceRepository, store } = makeService();
    store.requestInstantHardDeletion.mockResolvedValue(null);
    workspaceRepository.findOne
      .mockResolvedValueOnce({
        id: workspaceId,
        subdomain: input.workspaceSlug,
        activationStatus: WorkspaceActivationStatus.ACTIVE,
        deletionKind: null,
      })
      .mockResolvedValueOnce({
        ...pending,
        id: workspaceId,
        deletionKind: WorkspaceDeletionKind.MANUAL,
      });

    await expect(service.request(workspaceId, input)).rejects.toThrow(
      ConflictException,
    );
  });

  it('treats an absent workspace as idempotently complete', async () => {
    const { service, workspaceRepository, store, queue } = makeService();
    workspaceRepository.findOne.mockResolvedValue(null);

    await expect(service.request(workspaceId, input)).resolves.toEqual({
      operation: 'instant-hard-deletion',
      workspaceId,
      status: 'COMPLETED',
      phase: null,
      attemptCount: 0,
      lastProgressAt: null,
      errorCode: null,
      completed: true,
    });
    expect(store.requestInstantHardDeletion).not.toHaveBeenCalled();
    expect(queue.enqueue).not.toHaveBeenCalled();
  });
});
