import { STANDARD_OBJECTS } from 'twenty-shared/metadata';

import { type ApplicationService } from 'src/engine/core-modules/application/application.service';
import { type GlobalWorkspaceOrmManager } from 'src/engine/twenty-orm/global-workspace-datasource/global-workspace-orm.manager';
import { type WorkspaceCacheService } from 'src/engine/workspace-cache/services/workspace-cache.service';
import { TwentyStandardApplicationService } from 'src/engine/workspace-manager/twenty-standard-application/services/twenty-standard-application.service';
import { computeTwentyStandardApplicationAllFlatEntityMaps } from 'src/engine/workspace-manager/twenty-standard-application/utils/twenty-standard-application-all-flat-entity-maps.constant';
import { type WorkspaceMigrationValidateBuildAndRunService } from 'src/engine/workspace-manager/workspace-migration/services/workspace-migration-validate-build-and-run-service';

const WORKSPACE_ID = '20202020-0000-4000-8000-000000000011';
const STANDARD_APPLICATION_ID = '20202020-0000-4000-8000-000000000012';
const STANDARD_APPLICATION_UNIVERSAL_IDENTIFIER =
  '20202020-0000-4000-8000-000000000013';

describe('TwentyStandardApplicationService', () => {
  it('passes complete required standard view metadata to the migration path on every synchronization', async () => {
    const { allFlatEntityMaps } =
      computeTwentyStandardApplicationAllFlatEntityMaps({
        now: '2024-01-01T00:00:00.000Z',
        workspaceId: WORKSPACE_ID,
        twentyStandardApplicationId: STANDARD_APPLICATION_ID,
      });
    const getOrRecompute = jest.fn().mockResolvedValue({
      ...allFlatEntityMaps,
      featureFlagsMap: {},
    });
    const validateBuildAndRunWorkspaceMigrationFromTo = jest
      .fn()
      .mockResolvedValue({ status: 'success' });
    const service = new TwentyStandardApplicationService(
      {
        findWorkspaceTwentyStandardAndCustomApplicationOrThrow: jest
          .fn()
          .mockResolvedValue({
            twentyStandardFlatApplication: {
              id: STANDARD_APPLICATION_ID,
              universalIdentifier: STANDARD_APPLICATION_UNIVERSAL_IDENTIFIER,
            },
          }),
      } as unknown as ApplicationService,
      {
        validateBuildAndRunWorkspaceMigrationFromTo,
      } as unknown as WorkspaceMigrationValidateBuildAndRunService,
      { getOrRecompute } as unknown as WorkspaceCacheService,
      {} as GlobalWorkspaceOrmManager,
    );

    await service.synchronizeTwentyStandardApplicationOrThrow({
      workspaceId: WORKSPACE_ID,
    });
    await service.synchronizeTwentyStandardApplicationOrThrow({
      workspaceId: WORKSPACE_ID,
    });

    expect(validateBuildAndRunWorkspaceMigrationFromTo).toHaveBeenCalledTimes(
      2,
    );

    const syncPayloads =
      validateBuildAndRunWorkspaceMigrationFromTo.mock.calls.map(
        ([payload]) => payload,
      );
    const allCalendarEventsView =
      STANDARD_OBJECTS.calendarEvent.views.allCalendarEvents;

    for (const payload of syncPayloads) {
      const targetViews =
        payload.fromToAllFlatEntityMaps.flatViewMaps.to.byUniversalIdentifier;
      const targetViewFields =
        payload.fromToAllFlatEntityMaps.flatViewFieldMaps.to
          .byUniversalIdentifier;

      expect(targetViews[allCalendarEventsView.universalIdentifier]).toEqual(
        expect.objectContaining({
          universalIdentifier: allCalendarEventsView.universalIdentifier,
        }),
      );
      expect(
        Object.values(allCalendarEventsView.viewFields).every(
          ({ universalIdentifier }) =>
            targetViewFields[universalIdentifier] !== undefined,
        ),
      ).toBe(true);
      expect(
        Object.values(targetViews).filter(
          (view: { universalIdentifier?: string }) =>
            view?.universalIdentifier ===
            allCalendarEventsView.universalIdentifier,
        ),
      ).toHaveLength(1);
    }
  });
});
