import { type Repository } from 'typeorm';

import { type PostgresAdvisoryLockService } from 'src/database/typeorm/postgres-advisory-lock.service';
import { type TwentyConfigService } from 'src/engine/core-modules/twenty-config/twenty-config.service';
import { WorkspaceEntity } from 'src/engine/core-modules/workspace/workspace.entity';
import { CleanSuspendedWorkspacesBatchJob } from 'src/engine/workspace-manager/workspace-cleaner/jobs/clean-suspended-workspaces-batch.job';
import { type CleanerWorkspaceService } from 'src/engine/workspace-manager/workspace-cleaner/services/cleaner.workspace-service';

jest.mock('src/database/typeorm/postgres-advisory-lock.service', () => ({
  PostgresAdvisoryLockService: class {},
}));
jest.mock(
  'src/engine/core-modules/twenty-config/twenty-config.service',
  () => ({ TwentyConfigService: class {} }),
);
jest.mock('src/engine/core-modules/workspace/workspace.entity', () => ({
  WorkspaceEntity: class {},
}));
jest.mock(
  'src/engine/workspace-manager/workspace-cleaner/services/cleaner.workspace-service',
  () => ({ CleanerWorkspaceService: class {} }),
);

describe('CleanSuspendedWorkspacesBatchJob', () => {
  const workspaceRepository = {
    find: jest.fn(),
  };
  const cleanerWorkspaceService = {
    batchWarnOrCleanSuspendedWorkspaces: jest.fn(),
  };
  const twentyConfigService = {
    get: jest.fn((key: string) => {
      const values: Record<string, number> = {
        WORKSPACE_INACTIVE_DAYS_BEFORE_NOTIFICATION: 7,
        WORKSPACE_INACTIVE_DAYS_BEFORE_SOFT_DELETION: 14,
        WORKSPACE_INACTIVE_DAYS_BEFORE_DELETION: 21,
        MAX_NUMBER_OF_WORKSPACES_DELETED_PER_EXECUTION: 5,
      };

      return values[key];
    }),
  };
  const postgresAdvisoryLockService = {
    tryWithLock: jest.fn(),
  };

  const createJob = () =>
    new CleanSuspendedWorkspacesBatchJob(
      cleanerWorkspaceService as unknown as CleanerWorkspaceService,
      workspaceRepository as unknown as Repository<WorkspaceEntity>,
      twentyConfigService as unknown as TwentyConfigService,
      postgresAdvisoryLockService as unknown as PostgresAdvisoryLockService,
    );

  beforeEach(() => {
    jest.clearAllMocks();
    workspaceRepository.find
      .mockResolvedValueOnce([{ id: 'hard-delete-id' }])
      .mockResolvedValueOnce([{ id: 'warning-or-soft-delete-id' }]);
    postgresAdvisoryLockService.tryWithLock.mockImplementation(
      async (_lockName, callback) => ({
        acquired: true,
        value: await callback(),
      }),
    );
  });

  it('bounds hard deletes and excludes inactive workspaces with no cleanup due', async () => {
    await createJob().handle();

    expect(workspaceRepository.find).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({
        select: ['id'],
        where: expect.objectContaining({
          activationStatus: 'SUSPENDED',
          deletedAt: expect.objectContaining({ _type: 'lessThan' }),
        }),
        order: { deletedAt: 'ASC', id: 'ASC' },
        take: 5,
        withDeleted: true,
      }),
    );
    expect(workspaceRepository.find).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({
        select: ['id'],
        where: expect.objectContaining({
          activationStatus: 'SUSPENDED',
          deletedAt: expect.objectContaining({ _type: 'isNull' }),
          suspendedAt: expect.objectContaining({ _type: 'lessThan' }),
        }),
        order: { suspendedAt: 'ASC', id: 'ASC' },
        withDeleted: true,
      }),
    );
    expect(
      cleanerWorkspaceService.batchWarnOrCleanSuspendedWorkspaces,
    ).toHaveBeenCalledWith({
      workspaceIds: ['hard-delete-id', 'warning-or-soft-delete-id'],
    });
    // E2E discovery/recovery is deliberately absent from this hourly batch.
  });

  it('skips candidate selection when another cleanup owns the lock', async () => {
    postgresAdvisoryLockService.tryWithLock.mockResolvedValue({
      acquired: false,
    });

    await createJob().handle();

    expect(workspaceRepository.find).not.toHaveBeenCalled();
    expect(
      cleanerWorkspaceService.batchWarnOrCleanSuspendedWorkspaces,
    ).not.toHaveBeenCalled();
  });
});
