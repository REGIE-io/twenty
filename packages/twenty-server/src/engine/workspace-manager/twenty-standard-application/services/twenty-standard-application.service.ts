import { Injectable } from '@nestjs/common';
import {
  STANDARD_OBJECTS,
  STANDARD_PAGE_LAYOUT_UNIVERSAL_IDENTIFIERS,
} from 'twenty-shared/metadata';
import { isDefined } from 'twenty-shared/utils';

import { ApplicationService } from 'src/engine/core-modules/application/application.service';
import { FlatApplication } from 'src/engine/core-modules/application/types/flat-application.type';
import { MetadataFlatEntity } from 'src/engine/metadata-modules/flat-entity/types/metadata-flat-entity.type';
import { type FlatEntityMaps } from 'src/engine/metadata-modules/flat-entity/types/flat-entity-maps.type';
import { type SyncableFlatEntity } from 'src/engine/metadata-modules/flat-entity/types/flat-entity-from.type';
import { getMetadataFlatEntityMapsKey } from 'src/engine/metadata-modules/flat-entity/utils/get-metadata-flat-entity-maps-key.util';
import { getSubFlatEntityMapsByApplicationIdsOrThrow } from 'src/engine/metadata-modules/flat-entity/utils/get-sub-flat-entity-maps-by-application-ids-or-throw.util';
import { deleteFlatEntityFromFlatEntityMapsThroughMutationOrThrow } from 'src/engine/workspace-manager/workspace-migration/utils/delete-flat-entity-from-flat-entity-maps-through-mutation-or-throw.util';
import { GlobalWorkspaceOrmManager } from 'src/engine/twenty-orm/global-workspace-datasource/global-workspace-orm.manager';
import { WorkspaceCacheService } from 'src/engine/workspace-cache/services/workspace-cache.service';
import {
  TWENTY_STANDARD_ALL_METADATA_NAME,
  type TwentyStandardMetadataName,
} from 'src/engine/workspace-manager/twenty-standard-application/constants/twenty-standard-all-metadata-name.constant';
import { computeTwentyStandardApplicationAllFlatEntityMaps } from 'src/engine/workspace-manager/twenty-standard-application/utils/twenty-standard-application-all-flat-entity-maps.constant';
import { WorkspaceMigrationBuilderException } from 'src/engine/workspace-manager/workspace-migration/exceptions/workspace-migration-builder-exception';
import { WorkspaceMigrationValidateBuildAndRunService } from 'src/engine/workspace-manager/workspace-migration/services/workspace-migration-validate-build-and-run-service';
import { FromToAllUniversalFlatEntityMaps } from 'src/engine/workspace-manager/workspace-migration/types/workspace-migration-orchestrator.type';

const legacyCalendarEventRecordPageView =
  STANDARD_OBJECTS.calendarEvent.views.calendarEventRecordPageFields;
const legacyCalendarEventRecordPageLayout =
  STANDARD_PAGE_LAYOUT_UNIVERSAL_IDENTIFIERS.calendarEventRecordPage;

export const removeLegacyCalendarEventRecordPageFromCurrentSync = (
  allFlatEntityMaps: ReturnType<
    typeof computeTwentyStandardApplicationAllFlatEntityMaps
  >['allFlatEntityMaps'],
) => {
  const remove = <T extends SyncableFlatEntity>(
    flatEntityMaps: FlatEntityMaps<T>,
    universalIdentifiers: string[],
  ) => {
    for (const universalIdentifier of universalIdentifiers) {
      const entity = flatEntityMaps.byUniversalIdentifier[universalIdentifier];

      if (isDefined(entity)) {
        deleteFlatEntityFromFlatEntityMapsThroughMutationOrThrow({
          entityToDeleteId: entity.id,
          flatEntityMapsToMutate: flatEntityMaps,
        });
      }
    }
  };

  remove(allFlatEntityMaps.flatViewMaps, [
    legacyCalendarEventRecordPageView.universalIdentifier,
  ]);
  remove(
    allFlatEntityMaps.flatViewFieldGroupMaps,
    Object.values(legacyCalendarEventRecordPageView.viewFieldGroups).map(
      ({ universalIdentifier }) => universalIdentifier,
    ),
  );
  remove(
    allFlatEntityMaps.flatViewFieldMaps,
    Object.values(legacyCalendarEventRecordPageView.viewFields).map(
      ({ universalIdentifier }) => universalIdentifier,
    ),
  );
  remove(allFlatEntityMaps.flatPageLayoutMaps, [
    legacyCalendarEventRecordPageLayout.universalIdentifier,
  ]);
  remove(
    allFlatEntityMaps.flatPageLayoutTabMaps,
    Object.values(legacyCalendarEventRecordPageLayout.tabs).map(
      ({ universalIdentifier }) => universalIdentifier,
    ),
  );
  remove(
    allFlatEntityMaps.flatPageLayoutWidgetMaps,
    Object.values(legacyCalendarEventRecordPageLayout.tabs).flatMap(
      ({ widgets }) =>
        Object.values(widgets).map(
          ({ universalIdentifier }) => universalIdentifier,
        ),
    ),
  );
};
@Injectable()
export class TwentyStandardApplicationService {
  constructor(
    private readonly applicationService: ApplicationService,
    private readonly workspaceMigrationValidateBuildAndRunService: WorkspaceMigrationValidateBuildAndRunService,
    private readonly workspaceCacheService: WorkspaceCacheService,
    private readonly globalWorkspaceOrmManager: GlobalWorkspaceOrmManager,
  ) {}

  async synchronizeTwentyStandardApplicationOrThrow({
    workspaceId,
    excludedMetadataNames = [],
  }: {
    workspaceId: string;
    excludedMetadataNames?: readonly TwentyStandardMetadataName[];
  }): Promise<{ workspaceCustomFlatApplication: FlatApplication }> {
    const { twentyStandardFlatApplication, workspaceCustomFlatApplication } =
      await this.applicationService.findWorkspaceTwentyStandardAndCustomApplicationOrThrow(
        {
          workspaceId,
        },
      );
    const { featureFlagsMap, ...fromTwentyStandardAllFlatEntityMaps } =
      await this.workspaceCacheService.getOrRecompute(workspaceId, [
        ...TWENTY_STANDARD_ALL_METADATA_NAME.map(getMetadataFlatEntityMapsKey),
        'featureFlagsMap',
      ]);

    const {
      allFlatEntityMaps: toTwentyStandardAllFlatEntityMaps,
      idByUniversalIdentifierByMetadataName,
    } = computeTwentyStandardApplicationAllFlatEntityMaps({
      now: new Date().toISOString(),
      workspaceId,
      twentyStandardApplicationId: twentyStandardFlatApplication.id,
    });

    removeLegacyCalendarEventRecordPageFromCurrentSync(
      toTwentyStandardAllFlatEntityMaps,
    );

    const fromToAllFlatEntityMaps: FromToAllUniversalFlatEntityMaps = {};

    for (const metadataName of TWENTY_STANDARD_ALL_METADATA_NAME) {
      if (excludedMetadataNames.includes(metadataName)) {
        continue;
      }

      const flatEntityMapsKey = getMetadataFlatEntityMapsKey(metadataName);
      const fromFlatEntityMaps =
        fromTwentyStandardAllFlatEntityMaps[flatEntityMapsKey];
      const fromTo = {
        from: getSubFlatEntityMapsByApplicationIdsOrThrow<
          MetadataFlatEntity<typeof metadataName>
        >({
          applicationIds: [twentyStandardFlatApplication.id],
          flatEntityMaps: fromFlatEntityMaps,
        }),
        to: toTwentyStandardAllFlatEntityMaps[flatEntityMapsKey],
      };

      // @ts-expect-error Metadata flat entity maps cache key and metadataName colliding
      fromToAllFlatEntityMaps[flatEntityMapsKey] = fromTo;
    }

    const validateAndBuildResult =
      await this.workspaceMigrationValidateBuildAndRunService.validateBuildAndRunWorkspaceMigrationFromTo(
        {
          buildOptions: {
            isSystemBuild: true,
            inferDeletionFromMissingEntities: true,
            applicationUniversalIdentifier:
              twentyStandardFlatApplication.universalIdentifier,
          },
          fromToAllFlatEntityMaps,
          workspaceId,
          additionalCacheDataMaps: {
            featureFlagsMap,
          },
          idByUniversalIdentifierByMetadataName,
        },
      );

    if (validateAndBuildResult.status === 'fail') {
      throw new WorkspaceMigrationBuilderException(
        validateAndBuildResult,
        'Multiple validation errors occurred while synchronizing twenty-standard application',
      );
    }

    return { workspaceCustomFlatApplication };
  }
}
