import { STANDARD_OBJECTS } from 'twenty-shared/metadata';

import { createEmptyAllFlatEntityMaps } from 'src/engine/metadata-modules/flat-entity/constant/create-empty-all-flat-entity-maps.constant';
import { addFlatEntityToFlatEntityMapsOrThrow } from 'src/engine/metadata-modules/flat-entity/utils/add-flat-entity-to-flat-entity-maps-or-throw.util';
import { IndexMetadataEntity } from 'src/engine/metadata-modules/index-metadata/index-metadata.entity';
import { computeTwentyStandardApplicationAllFlatEntityMaps } from 'src/engine/workspace-manager/twenty-standard-application/utils/twenty-standard-application-all-flat-entity-maps.constant';
import { UpdateIndexActionHandlerService } from 'src/engine/workspace-manager/workspace-migration/workspace-migration-runner/action-handlers/index/services/update-index-action-handler.service';

const WORKSPACE_ID = '20202020-1111-4111-8111-111111111111';
const APPLICATION_ID = '20202020-2222-4222-8222-222222222222';

describe('UpdateIndexActionHandlerService identity reassignment', () => {
  it('updates only index identity metadata and never drops or recreates the physical index', async () => {
    const standardMaps = computeTwentyStandardApplicationAllFlatEntityMaps({
      now: '2026-09-06T00:00:00.000Z',
      workspaceId: WORKSPACE_ID,
      twentyStandardApplicationId: APPLICATION_ID,
    }).allFlatEntityMaps;
    const targetIndex =
      standardMaps.flatIndexMaps.byUniversalIdentifier[
        STANDARD_OBJECTS.regieListMembership.indexes.membershipKeyUniqueIndex
          .universalIdentifier
      ]!;
    const legacyIndex = {
      ...targetIndex,
      universalIdentifier: 'legacy-membership-index-ui',
      applicationId: 'legacy-application-id',
    };
    const allFlatEntityMaps = createEmptyAllFlatEntityMaps();

    allFlatEntityMaps.flatIndexMaps = addFlatEntityToFlatEntityMapsOrThrow({
      flatEntity: legacyIndex,
      flatEntityMaps: allFlatEntityMaps.flatIndexMaps,
    });

    const repositoryUpdate = jest.fn().mockResolvedValue(undefined);
    const dropIndex = jest.fn();
    const createIndex = jest.fn();
    const handler = new UpdateIndexActionHandlerService({
      indexManager: { dropIndex, createIndex },
    } as never);
    const queryRunner = {
      manager: {
        getRepository: jest.fn((entity) => {
          if (entity === IndexMetadataEntity) {
            return { update: repositoryUpdate };
          }

          throw new Error('unexpected repository');
        }),
      },
    };
    const context = {
      workspaceId: WORKSPACE_ID,
      queryRunner,
      allFlatEntityMaps,
      flatApplication: {
        id: APPLICATION_ID,
        universalIdentifier: 'standard-application-ui',
      },
      action: {
        type: 'update',
        metadataName: 'index',
        universalIdentifier: targetIndex.universalIdentifier,
        update: {},
        identityReassignment: {
          sourceUniversalIdentifier: legacyIndex.universalIdentifier,
          targetApplicationUniversalIdentifier: 'standard-application-ui',
        },
      },
    };
    const flatAction = await handler.transpileUniversalActionToFlatAction(
      context as never,
    );

    expect(flatAction).toMatchObject({
      entityId: legacyIndex.id,
      updatedFlatIndex: undefined,
      identityUpdate: {
        universalIdentifier: targetIndex.universalIdentifier,
        applicationId: APPLICATION_ID,
      },
    });

    await handler.executeForMetadata({ ...context, flatAction } as never);
    await handler.executeForWorkspaceSchema({
      ...context,
      flatAction,
    } as never);

    expect(repositoryUpdate).toHaveBeenCalledWith(
      { id: legacyIndex.id, workspaceId: WORKSPACE_ID },
      {
        universalIdentifier: targetIndex.universalIdentifier,
        applicationId: APPLICATION_ID,
      },
    );
    expect(dropIndex).not.toHaveBeenCalled();
    expect(createIndex).not.toHaveBeenCalled();
    expect(flatAction.entityId).toBe(legacyIndex.id);
  });
});
