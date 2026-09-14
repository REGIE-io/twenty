import { EmailingDomainWorkspaceCleanupJob } from 'src/engine/core-modules/emailing-domain/jobs/emailing-domain-workspace-cleanup.job';
import { FileWorkspaceFolderDeletionJob } from 'src/engine/core-modules/file/jobs/file-workspace-folder-deletion.job';
import { WorkspaceService } from 'src/engine/core-modules/workspace/services/workspace.service';

describe('WorkspaceService legacy hard deletion', () => {
  it('keeps ordinary suspended cleanup on the established async external-cleanup path', async () => {
    const steps: string[] = [];
    const service = Object.create(
      WorkspaceService.prototype,
    ) as WorkspaceService;
    const setServiceProperty = (name: string, value: unknown) => {
      Reflect.set(service, name, value);
    };
    const workspaceRepository = {
      findOne: jest.fn().mockResolvedValue({
        id: 'workspace-id',
        customDomain: null,
      }),
      delete: jest.fn().mockImplementation(async () => {
        steps.push('core-workspace-delete');
      }),
    };
    const messageQueueService = {
      add: jest.fn().mockImplementation(async (jobName: string) => {
        steps.push(jobName);
      }),
    };

    setServiceProperty('workspaceRepository', workspaceRepository);
    setServiceProperty('userWorkspaceRepository', {
      find: jest.fn().mockResolvedValue([]),
    });
    setServiceProperty('billingService', {
      isBillingEnabled: jest.fn().mockReturnValue(false),
    });
    setServiceProperty(
      'deleteWorkspaceSyncableMetadataEntities',
      jest.fn().mockResolvedValue(undefined),
    );
    setServiceProperty('workspaceDataSourceService', {
      deleteWorkspaceDBSchema: jest.fn().mockImplementation(async () => {
        steps.push('tenant-schema-delete');
      }),
    });
    setServiceProperty('phoneSearchWorkspaceCleanupService', {
      cleanupWorkspace: jest.fn().mockImplementation(async () => {
        steps.push('phone-search-cleanup');
      }),
    });
    setServiceProperty('workspaceCacheStorageService', {
      flush: jest.fn().mockResolvedValue(undefined),
    });
    setServiceProperty('flatEntityMapsCacheService', {
      flushFlatEntityMaps: jest.fn().mockResolvedValue(undefined),
    });
    setServiceProperty('messageQueueService', messageQueueService);
    setServiceProperty('coreDataSource', {
      getRepository: jest.fn().mockReturnValue({
        find: jest.fn().mockResolvedValue([]),
      }),
    });
    setServiceProperty('coreEntityCacheService', {
      invalidate: jest.fn().mockResolvedValue(undefined),
    });
    setServiceProperty('logger', { log: jest.fn() });

    await service.deleteWorkspace('workspace-id');

    expect(steps).toEqual([
      'tenant-schema-delete',
      'phone-search-cleanup',
      FileWorkspaceFolderDeletionJob.name,
      EmailingDomainWorkspaceCleanupJob.name,
      'core-workspace-delete',
    ]);
    expect(workspaceRepository.delete).toHaveBeenCalledWith('workspace-id');
  });
});
