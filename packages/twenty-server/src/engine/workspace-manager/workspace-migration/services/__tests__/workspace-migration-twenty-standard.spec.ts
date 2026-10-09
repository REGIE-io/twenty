import { TWENTY_STANDARD_APPLICATION } from 'src/engine/workspace-manager/twenty-standard-application/constants/twenty-standard-applications';
import { WorkspaceMigrationValidateBuildAndRunService } from 'src/engine/workspace-manager/workspace-migration/services/workspace-migration-validate-build-and-run-service';

describe('twenty-standard workspace migration', () => {
  const buildWorkspaceMigration = jest.fn();
  const computeFromToAllFlatEntityMapsAndBuildOptions = jest.fn();
  const expandWithSideEffects = jest.fn();
  const getOrRecomputeAllRelatedFlatEntityMaps = jest.fn();
  let service: WorkspaceMigrationValidateBuildAndRunService;

  beforeEach(() => {
    jest.clearAllMocks();
    getOrRecomputeAllRelatedFlatEntityMaps.mockResolvedValue({
      flatApplicationMaps: {},
      allRelatedFlatEntityMaps: {},
      allMetadataNameCacheToCompute: [],
    });
    computeFromToAllFlatEntityMapsAndBuildOptions.mockReturnValue({
      fromToAllFlatEntityMaps: {},
      inferDeletionFromMissingEntities: {},
      dependencyAllFlatEntityMaps: {},
      additionalCacheDataMaps: {},
      idByUniversalIdentifierByMetadataName: {},
    });
    buildWorkspaceMigration.mockResolvedValue({
      status: 'success',
      workspaceMigration: { actions: [] },
    });
    service = new WorkspaceMigrationValidateBuildAndRunService(
      { run: jest.fn() } as never,
      { buildWorkspaceMigration } as never,
      {
        getOrRecomputeAllRelatedFlatEntityMaps,
        computeFromToAllFlatEntityMapsAndBuildOptions,
      } as never,
      { emitMetadataEvents: jest.fn() } as never,
      { expandWithSideEffects } as never,
      { recordHistogram: jest.fn() } as never,
      { error: jest.fn(), perf: jest.fn() } as never,
      { get: jest.fn().mockReturnValue([]) } as never,
    );
  });

  it('builds standard metadata literally without custom-object side effects', async () => {
    await service.validateBuildAndRunTwentyStandardWorkspaceMigration({
      workspaceId: '20202020-1111-4111-8111-111111111111',
      applicationUniversalIdentifier:
        TWENTY_STANDARD_APPLICATION.universalIdentifier,
      dryRun: true,
      allFlatEntityOperationByMetadataName: {
        objectMetadata: {
          flatEntityToCreate: [],
          flatEntityToDelete: [],
          flatEntityToUpdate: [],
        },
      },
    });

    expect(expandWithSideEffects).not.toHaveBeenCalled();
    expect(buildWorkspaceMigration).toHaveBeenCalledWith(
      expect.objectContaining({
        buildOptions: expect.objectContaining({ isSystemBuild: true }),
      }),
    );
  });

  it('rejects attempts to target a non-standard application', async () => {
    await expect(
      service.validateBuildAndRunTwentyStandardWorkspaceMigration({
        workspaceId: '20202020-1111-4111-8111-111111111111',
        applicationUniversalIdentifier: 'not-twenty-standard',
        allFlatEntityOperationByMetadataName: {},
      }),
    ).rejects.toThrow('can only target the twenty-standard application');

    expect(getOrRecomputeAllRelatedFlatEntityMaps).not.toHaveBeenCalled();
    expect(expandWithSideEffects).not.toHaveBeenCalled();
  });
});
