import { STANDARD_OBJECTS } from 'twenty-shared/metadata';

import { createEmptyAllFlatEntityMaps } from 'src/engine/metadata-modules/flat-entity/constant/create-empty-all-flat-entity-maps.constant';
import { addFlatEntityToFlatEntityMapsOrThrow } from 'src/engine/metadata-modules/flat-entity/utils/add-flat-entity-to-flat-entity-maps-or-throw.util';
import { computeTwentyStandardApplicationAllFlatEntityMaps } from 'src/engine/workspace-manager/twenty-standard-application/utils/twenty-standard-application-all-flat-entity-maps.constant';
import { WorkspaceMigrationValidateBuildAndRunService } from 'src/engine/workspace-manager/workspace-migration/services/workspace-migration-validate-build-and-run-service';

const WORKSPACE_ID = '20202020-1111-4111-8111-111111111111';
const APPLICATION_ID = '20202020-2222-4222-8222-222222222222';
const APPLICATION_UNIVERSAL_IDENTIFIER = '20202020-0000-4000-8000-000000000001';

describe('workspace migration identity reassignment', () => {
  const run = jest.fn();
  const emitMetadataEvents = jest.fn();
  let allRelatedFlatEntityMaps = createEmptyAllFlatEntityMaps();
  let service: WorkspaceMigrationValidateBuildAndRunService;

  beforeEach(() => {
    jest.clearAllMocks();
    allRelatedFlatEntityMaps = createEmptyAllFlatEntityMaps();
    run.mockResolvedValue({
      hasSchemaMetadataChanged: true,
      metadataEvents: [],
    });
    service = new WorkspaceMigrationValidateBuildAndRunService(
      { run } as never,
      {} as never,
      {
        getOrRecomputeAllRelatedFlatEntityMaps: jest
          .fn()
          .mockImplementation(async () => ({
            flatApplicationMaps: {
              byId: {
                [APPLICATION_ID]: {
                  id: APPLICATION_ID,
                  universalIdentifier: APPLICATION_UNIVERSAL_IDENTIFIER,
                },
              },
              idByUniversalIdentifier: {
                [APPLICATION_UNIVERSAL_IDENTIFIER]: APPLICATION_ID,
              },
            },
            allRelatedFlatEntityMaps,
            allMetadataNameCacheToCompute: [],
          })),
      } as never,
      { emitMetadataEvents } as never,
      {} as never,
      { recordHistogram: jest.fn() } as never,
      { error: jest.fn(), perf: jest.fn() } as never,
      { get: jest.fn().mockReturnValue([]) } as never,
    );
  });

  const addLegacyObject = () => {
    const targetObject = computeTwentyStandardApplicationAllFlatEntityMaps({
      now: '2026-09-06T00:00:00.000Z',
      workspaceId: WORKSPACE_ID,
      twentyStandardApplicationId: APPLICATION_ID,
    }).allFlatEntityMaps.flatObjectMetadataMaps.byUniversalIdentifier[
      STANDARD_OBJECTS.regieStaticList.universalIdentifier
    ]!;
    const legacyObject = {
      ...targetObject,
      universalIdentifier: 'legacy-object-ui',
      applicationId: 'legacy-application-id',
    };

    allRelatedFlatEntityMaps.flatObjectMetadataMaps =
      addFlatEntityToFlatEntityMapsOrThrow({
        flatEntity: legacyObject,
        flatEntityMaps: allRelatedFlatEntityMaps.flatObjectMetadataMaps,
      });

    return { legacyObject, targetObject };
  };

  it('runs one transactional migration containing a source-to-target identity update', async () => {
    const { legacyObject, targetObject } = addLegacyObject();

    await service.validateAndRunWorkspaceMigrationIdentityReassignment({
      workspaceId: WORKSPACE_ID,
      applicationUniversalIdentifier: APPLICATION_UNIVERSAL_IDENTIFIER,
      identityReassignments: [
        {
          metadataName: 'objectMetadata',
          sourceUniversalIdentifier: legacyObject.universalIdentifier,
          targetUniversalIdentifier: targetObject.universalIdentifier,
        },
      ],
    });

    expect(run).toHaveBeenCalledWith({
      workspaceId: WORKSPACE_ID,
      workspaceMigration: {
        applicationUniversalIdentifier: APPLICATION_UNIVERSAL_IDENTIFIER,
        actions: [
          expect.objectContaining({
            type: 'update',
            metadataName: 'objectMetadata',
            universalIdentifier: targetObject.universalIdentifier,
            identityReassignment: {
              sourceUniversalIdentifier: legacyObject.universalIdentifier,
              targetApplicationUniversalIdentifier:
                APPLICATION_UNIVERSAL_IDENTIFIER,
            },
          }),
        ],
      },
    });
    expect(emitMetadataEvents).toHaveBeenCalled();
  });

  it('honors dry-run without invoking the runner', async () => {
    const { legacyObject, targetObject } = addLegacyObject();

    await service.validateAndRunWorkspaceMigrationIdentityReassignment({
      workspaceId: WORKSPACE_ID,
      applicationUniversalIdentifier: APPLICATION_UNIVERSAL_IDENTIFIER,
      dryRun: true,
      identityReassignments: [
        {
          metadataName: 'objectMetadata',
          sourceUniversalIdentifier: legacyObject.universalIdentifier,
          targetUniversalIdentifier: targetObject.universalIdentifier,
        },
      ],
    });

    expect(run).not.toHaveBeenCalled();
  });

  it('fails closed when another row already owns the target identifier', async () => {
    const { legacyObject, targetObject } = addLegacyObject();

    allRelatedFlatEntityMaps.flatObjectMetadataMaps =
      addFlatEntityToFlatEntityMapsOrThrow({
        flatEntity: {
          ...targetObject,
          id: 'conflicting-object-id',
        },
        flatEntityMaps: allRelatedFlatEntityMaps.flatObjectMetadataMaps,
      });

    await expect(
      service.validateAndRunWorkspaceMigrationIdentityReassignment({
        workspaceId: WORKSPACE_ID,
        applicationUniversalIdentifier: APPLICATION_UNIVERSAL_IDENTIFIER,
        identityReassignments: [
          {
            metadataName: 'objectMetadata',
            sourceUniversalIdentifier: legacyObject.universalIdentifier,
            targetUniversalIdentifier: targetObject.universalIdentifier,
          },
        ],
      }),
    ).rejects.toThrow('already held by conflicting-object-id');
    expect(run).not.toHaveBeenCalled();
  });
});
