import { WorkspaceService } from 'src/engine/core-modules/workspace/services/workspace.service';

describe('WorkspaceService phone-search cleanup ordering', () => {
  it('drops the tenant schema, cleans derived phone data, then deletes the core workspace', async () => {
    const steps: string[] = [];
    const service = Object.create(
      WorkspaceService.prototype,
    ) as WorkspaceService;
    const setServiceProperty = (name: string, value: unknown) => {
      Reflect.set(service, name, value);
    };

    setServiceProperty('workspaceRepository', {
      findOne: jest.fn().mockResolvedValue({
        id: 'workspace-id',
        customDomain: null,
      }),
    });
    setServiceProperty('workspaceDeletionMaintenanceService', {
      runInTransaction: jest.fn(
        async (
          _timeouts: unknown,
          operation: (manager: object) => Promise<void>,
        ) =>
          operation({
            delete: jest.fn().mockImplementation(async () => {
              steps.push('core-workspace-delete');
            }),
          }),
      ),
    });
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
    setServiceProperty('fileService', {
      deleteWorkspaceFolder: jest.fn().mockImplementation(async () => {
        steps.push('file-cleanup');
      }),
    });
    setServiceProperty('emailingDomainService', {
      cleanupEmailingDomainsForWorkspace: jest
        .fn()
        .mockImplementation(async () => {
          steps.push('emailing-domain-cleanup');
        }),
    });
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
      'file-cleanup',
      'emailing-domain-cleanup',
      'core-workspace-delete',
    ]);
  });
});
