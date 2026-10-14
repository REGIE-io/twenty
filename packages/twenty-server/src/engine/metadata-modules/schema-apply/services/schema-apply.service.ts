import { Injectable } from '@nestjs/common';

import { type FieldMetadataSettings } from 'twenty-shared/types';
import { isDefined } from 'twenty-shared/utils';
import { v4 } from 'uuid';

import { ApplicationService } from 'src/engine/core-modules/application/application.service';
import { type FlatApplication } from 'src/engine/core-modules/application/types/flat-application.type';
import { type CreateFieldInput } from 'src/engine/metadata-modules/field-metadata/dtos/create-field.input';
import { FieldMetadataService } from 'src/engine/metadata-modules/field-metadata/services/field-metadata.service';
import {
  mergeIndependentFieldOperations,
  toFieldCreateOperations,
  toFieldUpdateOperations,
} from 'src/engine/metadata-modules/field-metadata/services/utils/field-metadata-operations.util';
import { createEmptyAllFlatEntityMaps } from 'src/engine/metadata-modules/flat-entity/constant/create-empty-all-flat-entity-maps.constant';
import { WorkspaceManyOrAllFlatEntityMapsCacheService } from 'src/engine/metadata-modules/flat-entity/services/workspace-many-or-all-flat-entity-maps-cache.service';
import { type FlatEntityMaps } from 'src/engine/metadata-modules/flat-entity/types/flat-entity-maps.type';
import { type AllFlatEntityOperationByMetadataName } from 'src/engine/metadata-modules/flat-entity/types/flat-entity-to-create-delete-update.type';
import { addFlatEntityToFlatEntityMapsOrThrow } from 'src/engine/metadata-modules/flat-entity/utils/add-flat-entity-to-flat-entity-maps-or-throw.util';
import { type FlatObjectMetadata } from 'src/engine/metadata-modules/flat-object-metadata/types/flat-object-metadata.type';
import { fromCreateViewInputToFlatViewToCreate } from 'src/engine/metadata-modules/flat-view/utils/from-create-view-input-to-flat-view-to-create.util';
import {
  ObjectMetadataService,
  type ObjectToCreateOperations,
} from 'src/engine/metadata-modules/object-metadata/object-metadata.service';
import { buildReservedSystemFlatFieldMetadatasForCustomObject } from 'src/engine/metadata-modules/object-metadata/utils/build-reserved-system-flat-field-metadatas-for-custom-object.util';
import { type ApplySchemaFieldInput } from 'src/engine/metadata-modules/schema-apply/dtos/apply-schema-field.input';
import { type ApplySchemaInput } from 'src/engine/metadata-modules/schema-apply/dtos/apply-schema.input';
import {
  SchemaApplyException,
  SchemaApplyExceptionCode,
} from 'src/engine/metadata-modules/schema-apply/schema-apply.exception';
import { type SchemaApplyPlan } from 'src/engine/metadata-modules/schema-apply/types/schema-apply-plan.type';
import { type SchemaApplyResult } from 'src/engine/metadata-modules/schema-apply/types/schema-apply-result.type';
import { buildSchemaApplyResult } from 'src/engine/metadata-modules/schema-apply/utils/build-schema-apply-result.util';
import { buildSchemaApplySnapshot } from 'src/engine/metadata-modules/schema-apply/utils/build-schema-apply-snapshot.util';
import { buildUniversalFlatIndexForSchemaApply } from 'src/engine/metadata-modules/schema-apply/utils/build-universal-flat-index-for-schema-apply.util';
import {
  computeSchemaApplyPlan,
  hasSchemaApplyPlanChanges,
} from 'src/engine/metadata-modules/schema-apply/utils/compute-schema-apply-plan.util';
import { WorkspaceMigrationBuilderException } from 'src/engine/workspace-manager/workspace-migration/exceptions/workspace-migration-builder-exception';
import { WorkspaceMigrationValidateBuildAndRunService } from 'src/engine/workspace-manager/workspace-migration/services/workspace-migration-validate-build-and-run-service';
import { type UniversalFlatFieldMetadata } from 'src/engine/workspace-manager/workspace-migration/universal-flat-entity/types/universal-flat-field-metadata.type';
import { fromUniversalFlatObjectMetadataToFlatObjectMetadata } from 'src/engine/workspace-manager/workspace-migration/workspace-migration-runner/action-handlers/object/services/utils/from-universal-flat-object-metadata-to-flat-object-metadata.util';

type SchemaApplyFlatEntityMaps = Awaited<
  ReturnType<FieldMetadataService['getFieldUpdateFlatEntityMaps']>
>;

const toFieldKey = (objectUniversalIdentifier: string, name: string) =>
  `${objectUniversalIdentifier}.${name}`;

@Injectable()
export class SchemaApplyService {
  constructor(
    private readonly applicationService: ApplicationService,
    private readonly flatEntityMapsCacheService: WorkspaceManyOrAllFlatEntityMapsCacheService,
    private readonly workspaceMigrationValidateBuildAndRunService: WorkspaceMigrationValidateBuildAndRunService,
    private readonly objectMetadataService: ObjectMetadataService,
    private readonly fieldMetadataService: FieldMetadataService,
  ) {}

  // Applies everything missing in one workspace migration: every migration pays a
  // post-commit cache rebuild, which dominates the cost of provisioning a schema.
  async applySchema({
    workspaceId,
    schema,
  }: {
    workspaceId: string;
    schema: ApplySchemaInput;
  }): Promise<SchemaApplyResult> {
    const flatEntityMaps =
      await this.fieldMetadataService.getFieldUpdateFlatEntityMaps(workspaceId);
    const snapshot = buildSchemaApplySnapshot(flatEntityMaps);
    const plan = computeSchemaApplyPlan({ schema, snapshot });

    if (!hasSchemaApplyPlanChanges(plan)) {
      return buildSchemaApplyResult({ plan, snapshot });
    }

    const { workspaceCustomFlatApplication } =
      await this.applicationService.findWorkspaceTwentyStandardAndCustomApplicationOrThrow(
        { workspaceId },
      );

    const allFlatEntityOperationByMetadataName =
      await this.buildFlatEntityOperations({
        plan,
        flatEntityMaps,
        workspaceId,
        flatApplication: workspaceCustomFlatApplication,
      });

    const validateAndBuildResult =
      await this.workspaceMigrationValidateBuildAndRunService.validateBuildAndRunWorkspaceMigration(
        {
          allFlatEntityOperationByMetadataName,
          workspaceId,
          isSystemBuild: false,
          applicationUniversalIdentifier:
            workspaceCustomFlatApplication.universalIdentifier,
        },
      );

    if (validateAndBuildResult.status === 'fail') {
      throw new WorkspaceMigrationBuilderException(
        validateAndBuildResult,
        'Validation errors occurred while applying schema',
      );
    }

    const recomputedFlatEntityMaps =
      await this.flatEntityMapsCacheService.getOrRecomputeManyOrAllFlatEntityMaps(
        {
          workspaceId,
          flatMapsKeys: [
            'flatObjectMetadataMaps',
            'flatFieldMetadataMaps',
            'flatIndexMaps',
            'flatViewMaps',
          ],
        },
      );

    return buildSchemaApplyResult({
      plan,
      snapshot: buildSchemaApplySnapshot(recomputedFlatEntityMaps),
    });
  }

  private async buildFlatEntityOperations({
    plan,
    flatEntityMaps,
    workspaceId,
    flatApplication,
  }: {
    plan: SchemaApplyPlan;
    flatEntityMaps: SchemaApplyFlatEntityMaps;
    workspaceId: string;
    flatApplication: FlatApplication;
  }): Promise<AllFlatEntityOperationByMetadataName> {
    const createObjectInputs = plan.objects
      .filter(({ isMissing }) => isMissing)
      .map(({ input }) => ({
        nameSingular: input.nameSingular,
        namePlural: input.namePlural,
        labelSingular: input.labelSingular,
        labelPlural: input.labelPlural,
        icon: input.icon,
        description: input.description,
      }));

    const { objectsToCreate }: { objectsToCreate: ObjectToCreateOperations[] } =
      createObjectInputs.length > 0
        ? await this.objectMetadataService.buildCreateManyObjectsOperations({
            createObjectInputs,
            workspaceId,
            ownerFlatApplication: flatApplication,
          })
        : { objectsToCreate: [] };

    // Field, index and view transpilers resolve objects through the flat maps, so
    // objects created by this same migration have to be visible there first.
    const emptyAllFlatEntityMaps = createEmptyAllFlatEntityMaps();
    const flatObjectMetadataMaps = objectsToCreate.reduce<
      FlatEntityMaps<FlatObjectMetadata>
    >(
      (
        maps,
        { flatObjectMetadataToCreate, flatFieldMetadataToCreateOnObject },
      ) =>
        addFlatEntityToFlatEntityMapsOrThrow<FlatObjectMetadata>({
          flatEntity: fromUniversalFlatObjectMetadataToFlatObjectMetadata({
            universalFlatObjectMetadata: flatObjectMetadataToCreate,
            generatedId: flatObjectMetadataToCreate.id,
            allFlatEntityMaps: {
              ...emptyAllFlatEntityMaps,
              flatFieldMetadataMaps: flatEntityMaps.flatFieldMetadataMaps,
            },
            allFieldIdToBeCreatedInActionByUniversalIdentifierMap: new Map(
              flatFieldMetadataToCreateOnObject.map((flatFieldMetadata) => [
                flatFieldMetadata.universalIdentifier,
                v4(),
              ]),
            ),
            context: { workspaceId, flatApplication },
          }),
          flatEntityMaps: maps,
        }),
      flatEntityMaps.flatObjectMetadataMaps,
    );

    const flatObjectMetadataByNameSingular = new Map(
      Object.values(flatObjectMetadataMaps.byUniversalIdentifier)
        .filter(isDefined)
        .map((flatObjectMetadata) => [
          flatObjectMetadata.nameSingular,
          flatObjectMetadata,
        ]),
    );
    const getFlatObjectMetadataOrThrow = (nameSingular: string) => {
      const flatObjectMetadata =
        flatObjectMetadataByNameSingular.get(nameSingular);

      if (!isDefined(flatObjectMetadata)) {
        throw new SchemaApplyException(
          `Object ${nameSingular} could not be resolved`,
          SchemaApplyExceptionCode.INTERNAL_SERVER_ERROR,
        );
      }

      return flatObjectMetadata;
    };

    const {
      flatFieldMetadatasToCreate,
      flatIndexMetadatasToCreate: relationFlatIndexMetadatasToCreate,
    } = await this.fieldMetadataService.transpileCreateFieldInputsOrThrow({
      createFieldInputs: plan.fields
        .filter(({ isMissing }) => isMissing)
        .map(({ input }) =>
          this.toCreateFieldInput({
            input,
            getObjectId: (nameSingular) =>
              getFlatObjectMetadataOrThrow(nameSingular).id,
          }),
        ),
      flatObjectMetadataMaps,
      flatFieldMetadataMaps: flatEntityMaps.flatFieldMetadataMaps,
      flatApplication,
    });

    const objectFlatFieldMetadatasToCreate = objectsToCreate.flatMap(
      ({ flatFieldMetadataToCreateOnObject }) =>
        flatFieldMetadataToCreateOnObject,
    );

    const requestedFlatIndexMetadatasToCreate = this.buildRequestedIndexes({
      plan,
      flatEntityMaps,
      getFlatObjectMetadataOrThrow,
      flatFieldMetadatasAfterApply: [
        ...Object.values(
          flatEntityMaps.flatFieldMetadataMaps.byUniversalIdentifier,
        ).filter(isDefined),
        ...objectFlatFieldMetadatasToCreate,
        // The engine adds these through a side effect; their identifiers are
        // deterministic, so an index can target them in the same migration.
        ...objectsToCreate.flatMap(({ flatObjectMetadataToCreate }) =>
          Object.values(
            buildReservedSystemFlatFieldMetadatasForCustomObject({
              flatObjectMetadata: flatObjectMetadataToCreate,
            }),
          ),
        ),
        ...flatFieldMetadatasToCreate,
      ],
      flatApplication,
    });

    const flatViewsToCreate = plan.views
      .filter(({ isMissing }) => isMissing)
      .map(
        ({ input }) =>
          fromCreateViewInputToFlatViewToCreate({
            createViewInput: {
              name: input.name,
              icon: input.icon,
              type: input.type,
              objectMetadataId: getFlatObjectMetadataOrThrow(
                input.objectNameSingular,
              ).id,
            },
            flatApplication,
            flatFieldMetadataMaps: flatEntityMaps.flatFieldMetadataMaps,
            flatObjectMetadataMaps,
          }).flatViewToCreate,
      );

    const fieldSettingsTranspilations = plan.fieldSettings
      .filter(({ isChanged }) => isChanged)
      .map(({ fieldId, mergedSettings }) =>
        this.fieldMetadataService.transpileUpdateFieldInputOrThrow({
          updateFieldInput: {
            id: fieldId,
            settings: mergedSettings as FieldMetadataSettings,
          },
          workspaceId,
          flatEntityMaps,
          flatApplication,
          isSystemBuild: false,
        }),
      );

    const fieldOperations = mergeIndependentFieldOperations([
      toFieldCreateOperations({
        flatFieldMetadatasToCreate: [
          ...objectFlatFieldMetadatasToCreate,
          ...flatFieldMetadatasToCreate,
        ],
        flatIndexMetadatasToCreate: [
          ...relationFlatIndexMetadatasToCreate,
          ...requestedFlatIndexMetadatasToCreate,
        ],
      }),
      ...fieldSettingsTranspilations.map(toFieldUpdateOperations),
    ]);

    return {
      ...fieldOperations,
      view: {
        ...fieldOperations.view,
        flatEntityToCreate: [
          ...fieldOperations.view.flatEntityToCreate,
          ...flatViewsToCreate,
        ],
      },
      ...(objectsToCreate.length > 0
        ? {
            objectMetadata: {
              flatEntityToCreate: objectsToCreate.map(
                ({ flatObjectMetadataToCreate }) => flatObjectMetadataToCreate,
              ),
              flatEntityToDelete: [],
              flatEntityToUpdate: [],
            },
            commandMenuItem: {
              flatEntityToCreate: objectsToCreate.map(
                ({ flatCommandMenuItemToCreate }) =>
                  flatCommandMenuItemToCreate,
              ),
              flatEntityToDelete: [],
              flatEntityToUpdate: [],
            },
            navigationMenuItem: {
              flatEntityToCreate: objectsToCreate.map(
                ({ flatNavigationMenuItemToCreate }) =>
                  flatNavigationMenuItemToCreate,
              ),
              flatEntityToDelete: [],
              flatEntityToUpdate: [],
            },
          }
        : {}),
    };
  }

  private toCreateFieldInput({
    input,
    getObjectId,
  }: {
    input: ApplySchemaFieldInput;
    getObjectId: (nameSingular: string) => string;
  }): Omit<CreateFieldInput, 'workspaceId'> {
    return {
      objectMetadataId: getObjectId(input.objectNameSingular),
      name: input.name,
      label: input.label,
      type: input.type,
      description: input.description,
      icon: input.icon,
      isNullable: input.isNullable,
      isLabelSyncedWithName: input.isLabelSyncedWithName,
      settings: input.settings as FieldMetadataSettings | undefined,
      options: input.options,
      relationCreationPayload: isDefined(input.relation)
        ? {
            type: input.relation.type,
            targetObjectMetadataId: getObjectId(
              input.relation.targetObjectNameSingular,
            ),
            targetFieldName: input.relation.targetFieldName,
            targetFieldLabel: input.relation.targetFieldLabel,
            targetFieldIcon: input.relation.targetFieldIcon,
            onDelete: input.relation.onDelete,
          }
        : undefined,
    };
  }

  private buildRequestedIndexes({
    plan,
    flatEntityMaps,
    getFlatObjectMetadataOrThrow,
    flatFieldMetadatasAfterApply,
    flatApplication,
  }: {
    plan: SchemaApplyPlan;
    flatEntityMaps: SchemaApplyFlatEntityMaps;
    getFlatObjectMetadataOrThrow: (nameSingular: string) => FlatObjectMetadata;
    flatFieldMetadatasAfterApply: UniversalFlatFieldMetadata[];
    flatApplication: FlatApplication;
  }) {
    const flatFieldMetadataByKey = new Map(
      flatFieldMetadatasAfterApply.map((flatFieldMetadata) => [
        toFieldKey(
          flatFieldMetadata.objectMetadataUniversalIdentifier,
          flatFieldMetadata.name,
        ),
        flatFieldMetadata,
      ]),
    );
    const existingFlatIndexMetadatas = Object.values(
      flatEntityMaps.flatIndexMaps.byUniversalIdentifier,
    ).filter(isDefined);
    const missingIndexes = plan.indexes
      .filter(({ isMissing }) => isMissing)
      .map(({ input }) => input);
    const createdAt = new Date().toISOString();

    return missingIndexes.map((index, position) => {
      const flatObjectMetadata = getFlatObjectMetadataOrThrow(
        index.objectNameSingular,
      );
      const orderedFlatFieldMetadatas = index.fieldNames.map((fieldName) => {
        const flatFieldMetadata = flatFieldMetadataByKey.get(
          toFieldKey(flatObjectMetadata.universalIdentifier, fieldName),
        );

        if (!isDefined(flatFieldMetadata)) {
          throw new SchemaApplyException(
            `Field ${index.objectNameSingular}.${fieldName} cannot be indexed by the request that creates its object`,
            SchemaApplyExceptionCode.FIELD_NOT_FOUND,
          );
        }

        return flatFieldMetadata;
      });
      const customIndexCountOnObject =
        existingFlatIndexMetadatas.filter(
          (flatIndexMetadata) =>
            flatIndexMetadata.isCustom &&
            flatIndexMetadata.objectMetadataId === flatObjectMetadata.id,
        ).length +
        missingIndexes
          .slice(0, position)
          .filter(
            (pendingIndex) =>
              pendingIndex.objectNameSingular === index.objectNameSingular,
          ).length;

      return buildUniversalFlatIndexForSchemaApply({
        index,
        flatObjectMetadata,
        orderedFlatFieldMetadatas,
        customIndexCountOnObject,
        applicationUniversalIdentifier: flatApplication.universalIdentifier,
        createdAt,
      });
    });
  }
}
