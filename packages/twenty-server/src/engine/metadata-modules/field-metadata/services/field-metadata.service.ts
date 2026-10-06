import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';

import { STANDARD_OBJECTS } from 'twenty-shared/metadata';
import { FieldMetadataType } from 'twenty-shared/types';
import { isDefined } from 'twenty-shared/utils';
import { type FindOneOptions, type Repository } from 'typeorm';

import { ApplicationService } from 'src/engine/core-modules/application/application.service';
import { PhoneSearchMetadataGateService } from 'src/engine/core-modules/phone-search-index/services/phone-search-metadata-gate.service';
import { type FlatApplication } from 'src/engine/core-modules/application/types/flat-application.type';
import { type CreateFieldInput } from 'src/engine/metadata-modules/field-metadata/dtos/create-field.input';
import { type DeleteOneFieldInput } from 'src/engine/metadata-modules/field-metadata/dtos/delete-field.input';
import { type UpdateFieldInput } from 'src/engine/metadata-modules/field-metadata/dtos/update-field.input';
import { FieldMetadataEntity } from 'src/engine/metadata-modules/field-metadata/field-metadata.entity';
import {
  FieldMetadataException,
  FieldMetadataExceptionCode,
} from 'src/engine/metadata-modules/field-metadata/field-metadata.exception';
import { WorkspaceManyOrAllFlatEntityMapsCacheService } from 'src/engine/metadata-modules/flat-entity/services/workspace-many-or-all-flat-entity-maps-cache.service';
import { findFlatEntityByUniversalIdentifierOrThrow } from 'src/engine/metadata-modules/flat-entity/utils/find-flat-entity-by-universal-identifier-or-throw.util';
import { findFlatEntityByUniversalIdentifier } from 'src/engine/metadata-modules/flat-entity/utils/find-flat-entity-by-universal-identifier.util';
import { findManyFlatEntityByUniversalIdentifierInUniversalFlatEntityMapsOrThrow } from 'src/engine/metadata-modules/flat-entity/utils/find-many-flat-entity-by-universal-identifier-in-universal-flat-entity-maps-or-throw.util';
import { type FlatFieldMetadata } from 'src/engine/metadata-modules/flat-field-metadata/types/flat-field-metadata.type';
import { fromCreateFieldInputToFlatFieldMetadatasToCreate } from 'src/engine/metadata-modules/flat-field-metadata/utils/from-create-field-input-to-flat-field-metadatas-to-create.util';
import { fromDeleteFieldInputToFlatFieldMetadatasToDelete } from 'src/engine/metadata-modules/flat-field-metadata/utils/from-delete-field-input-to-flat-field-metadatas-to-delete.util';
import { fromUpdateFieldInputToFlatFieldMetadata } from 'src/engine/metadata-modules/flat-field-metadata/utils/from-update-field-input-to-flat-field-metadata.util';
import { throwOnFieldInputTranspilationsError } from 'src/engine/metadata-modules/flat-field-metadata/utils/throw-on-field-input-transpilations-error.util';
import { WidgetConfigurationType } from 'src/engine/metadata-modules/page-layout-widget/enums/widget-configuration-type.type';
import { WorkspaceCacheService } from 'src/engine/workspace-cache/services/workspace-cache.service';
import { EMPTY_ORCHESTRATOR_FAILURE_REPORT } from 'src/engine/workspace-manager/workspace-migration/constant/empty-orchestrator-failure-report.constant';
import { WorkspaceMigrationBuilderException } from 'src/engine/workspace-manager/workspace-migration/exceptions/workspace-migration-builder-exception';
import { WorkspaceMigrationValidateBuildAndRunService } from 'src/engine/workspace-manager/workspace-migration/services/workspace-migration-validate-build-and-run-service';
import { type UniversalFlatFieldMetadata } from 'src/engine/workspace-manager/workspace-migration/universal-flat-entity/types/universal-flat-field-metadata.type';
import {
  type FieldUpdateTranspilation,
  mergeIndependentFieldOperations,
  toFieldCreateOperations,
  toFieldUpdateOperations,
} from 'src/engine/metadata-modules/field-metadata/services/utils/field-metadata-operations.util';

type CreateFieldTranspilationArgs = Parameters<
  typeof fromCreateFieldInputToFlatFieldMetadatasToCreate
>[0];

@Injectable()
export class FieldMetadataService {
  constructor(
    @InjectRepository(FieldMetadataEntity)
    private readonly fieldMetadataRepository: Repository<FieldMetadataEntity>,
    private readonly flatEntityMapsCacheService: WorkspaceManyOrAllFlatEntityMapsCacheService,
    private readonly workspaceMigrationValidateBuildAndRunService: WorkspaceMigrationValidateBuildAndRunService,
    private readonly applicationService: ApplicationService,
    private readonly workspaceCacheService: WorkspaceCacheService,
    private readonly phoneSearchMetadataGateService?: PhoneSearchMetadataGateService,
  ) {}

  async findManyWithinWorkspace({
    workspaceId,
    fieldMetadataId,
    objectMetadataId,
    limit,
  }: {
    workspaceId: string;
    fieldMetadataId?: string;
    objectMetadataId?: string;
    limit: number;
  }): Promise<FieldMetadataEntity[]> {
    return this.fieldMetadataRepository.find({
      where: {
        workspaceId,
        ...(isDefined(fieldMetadataId) ? { id: fieldMetadataId } : {}),
        ...(isDefined(objectMetadataId) ? { objectMetadataId } : {}),
      },
      take: limit,
    });
  }

  async createOneField({
    createFieldInput,
    workspaceId,
    ownerFlatApplication,
  }: {
    createFieldInput: Omit<CreateFieldInput, 'workspaceId'>;
    workspaceId: string;
    ownerFlatApplication?: FlatApplication;
  }): Promise<FlatFieldMetadata> {
    const [createdFieldMetadata] = await this.createManyFields({
      workspaceId,
      createFieldInputs: [createFieldInput],
      ownerFlatApplication,
    });

    if (!isDefined(createdFieldMetadata)) {
      throw new FieldMetadataException(
        'Failed to create field metadata',
        FieldMetadataExceptionCode.INTERNAL_SERVER_ERROR,
      );
    }

    return createdFieldMetadata;
  }

  async deleteOneField({
    deleteOneFieldInput,
    workspaceId,
    isSystemBuild = false,
    ownerFlatApplication,
  }: {
    deleteOneFieldInput: DeleteOneFieldInput;
    workspaceId: string;
    isSystemBuild?: boolean;
    ownerFlatApplication?: FlatApplication;
  }): Promise<FlatFieldMetadata> {
    const resolvedOwnerFlatApplication =
      ownerFlatApplication ??
      (
        await this.applicationService.findWorkspaceTwentyStandardAndCustomApplicationOrThrow(
          { workspaceId },
        )
      ).workspaceCustomFlatApplication;

    const {
      flatObjectMetadataMaps: existingFlatObjectMetadataMaps,
      flatIndexMaps: existingFlatIndexMaps,
      flatFieldMetadataMaps: existingFlatFieldMetadataMaps,
      flatPageLayoutWidgetMaps: existingFlatPageLayoutWidgetMaps,
    } = await this.flatEntityMapsCacheService.getOrRecomputeManyOrAllFlatEntityMaps(
      {
        workspaceId,
        flatMapsKeys: [
          'flatObjectMetadataMaps',
          'flatIndexMaps',
          'flatFieldMetadataMaps',
          'flatPageLayoutWidgetMaps',
        ],
      },
    );

    const {
      flatFieldMetadatasToDelete,
      flatIndexesToDelete,
      flatIndexesToUpdate,
    } = fromDeleteFieldInputToFlatFieldMetadatasToDelete({
      deleteOneFieldInput,
      flatFieldMetadataMaps: existingFlatFieldMetadataMaps,
      flatIndexMaps: existingFlatIndexMaps,
      flatObjectMetadataMaps: existingFlatObjectMetadataMaps,
    });

    const deletedFlatFieldMetadata = findFlatEntityByUniversalIdentifierOrThrow(
      {
        universalIdentifier: flatFieldMetadatasToDelete[0].universalIdentifier,
        flatEntityMaps: existingFlatFieldMetadataMaps,
      },
    );

    const deletedFieldIds = new Set(
      flatFieldMetadatasToDelete
        .map((f) => {
          const resolved = findFlatEntityByUniversalIdentifier({
            universalIdentifier: f.universalIdentifier,
            flatEntityMaps: existingFlatFieldMetadataMaps,
          });

          return resolved?.id;
        })
        .filter(isDefined),
    );

    const flatPageLayoutWidgetsToDelete = Object.values(
      existingFlatPageLayoutWidgetMaps.byUniversalIdentifier,
    )
      .filter(isDefined)
      .filter(
        (widget) =>
          !isDefined(widget.deletedAt) &&
          widget.configuration?.configurationType ===
            WidgetConfigurationType.FIELD &&
          deletedFieldIds.has(widget.configuration.fieldMetadataId),
      );

    const validateAndBuildResult =
      await this.workspaceMigrationValidateBuildAndRunService.validateBuildAndRunWorkspaceMigration(
        {
          allFlatEntityOperationByMetadataName: {
            fieldMetadata: {
              flatEntityToCreate: [],
              flatEntityToDelete: flatFieldMetadatasToDelete,
              flatEntityToUpdate: [],
            },
            index: {
              flatEntityToCreate: [],
              flatEntityToDelete: flatIndexesToDelete,
              flatEntityToUpdate: flatIndexesToUpdate,
            },
            ...(flatPageLayoutWidgetsToDelete.length > 0
              ? {
                  pageLayoutWidget: {
                    flatEntityToCreate: [],
                    flatEntityToDelete: flatPageLayoutWidgetsToDelete,
                    flatEntityToUpdate: [],
                  },
                }
              : {}),
          },
          workspaceId,
          isSystemBuild,
          applicationUniversalIdentifier:
            resolvedOwnerFlatApplication.universalIdentifier,
        },
      );

    if (validateAndBuildResult.status === 'fail') {
      throw new WorkspaceMigrationBuilderException(
        validateAndBuildResult,
        'Multiple validation errors occurred while deleting field',
      );
    }

    return deletedFlatFieldMetadata;
  }

  async updateOneField({
    updateFieldInput,
    workspaceId,
    isSystemBuild = false,
    ownerFlatApplication,
  }: {
    updateFieldInput: Omit<UpdateFieldInput, 'workspaceId'>;
    workspaceId: string;
    isSystemBuild?: boolean;
    ownerFlatApplication?: FlatApplication;
  }): Promise<FlatFieldMetadata> {
    const resolvedOwnerFlatApplication =
      ownerFlatApplication ??
      (
        await this.applicationService.findWorkspaceTwentyStandardAndCustomApplicationOrThrow(
          { workspaceId },
        )
      ).workspaceCustomFlatApplication;

    const flatEntityMaps = await this.getFieldUpdateFlatEntityMaps(workspaceId);
    const transpilation = this.transpileUpdateFieldInputOrThrow({
      updateFieldInput,
      workspaceId,
      flatEntityMaps,
      flatApplication: resolvedOwnerFlatApplication,
      isSystemBuild,
    });

    const validateAndBuildResult =
      await this.workspaceMigrationValidateBuildAndRunService.validateBuildAndRunWorkspaceMigration(
        {
          allFlatEntityOperationByMetadataName:
            toFieldUpdateOperations(transpilation),
          workspaceId,
          isSystemBuild,
          applicationUniversalIdentifier:
            resolvedOwnerFlatApplication.universalIdentifier,
        },
      );

    if (validateAndBuildResult.status === 'fail') {
      throw new WorkspaceMigrationBuilderException(
        validateAndBuildResult,
        'Multiple validation errors occurred while updating field',
      );
    }

    const { flatFieldMetadataMaps: recomputedFlatFieldMetadataMaps } =
      await this.flatEntityMapsCacheService.getOrRecomputeManyOrAllFlatEntityMaps(
        {
          workspaceId,
          flatMapsKeys: ['flatFieldMetadataMaps'],
        },
      );

    return findFlatEntityByUniversalIdentifierOrThrow({
      universalIdentifier:
        transpilation.flatFieldMetadatasToUpdate[0].universalIdentifier,
      flatEntityMaps: recomputedFlatFieldMetadataMaps,
    });
  }

  // One workspace migration for every change: each metadata migration pays a full cache
  // rebuild after commit, which dominates small changes like a settings patch.
  async createAndUpdateManyFields({
    createFieldInputs,
    updateFieldInputs,
    workspaceId,
  }: {
    createFieldInputs: Omit<CreateFieldInput, 'workspaceId'>[];
    updateFieldInputs: Omit<UpdateFieldInput, 'workspaceId'>[];
    workspaceId: string;
  }): Promise<{ created: FlatFieldMetadata[]; updated: FlatFieldMetadata[] }> {
    if (createFieldInputs.length === 0 && updateFieldInputs.length === 0) {
      return { created: [], updated: [] };
    }

    const { workspaceCustomFlatApplication } =
      await this.applicationService.findWorkspaceTwentyStandardAndCustomApplicationOrThrow(
        { workspaceId },
      );
    const flatEntityMaps = await this.getFieldUpdateFlatEntityMaps(workspaceId);

    const { transpilations: createTranspilations, ...createOperations } =
      await this.transpileCreateFieldInputsOrThrow({
        createFieldInputs,
        flatObjectMetadataMaps: flatEntityMaps.flatObjectMetadataMaps,
        flatFieldMetadataMaps: flatEntityMaps.flatFieldMetadataMaps,
        flatApplication: workspaceCustomFlatApplication,
      });

    await this.assertPhoneSearchAvailableForCreatedFields({
      workspaceId,
      flatObjectMetadataMaps: flatEntityMaps.flatObjectMetadataMaps,
      flatFieldMetadatasToCreate: createOperations.flatFieldMetadatasToCreate,
    });

    const updateTranspilations = updateFieldInputs.map((updateFieldInput) =>
      this.transpileUpdateFieldInputOrThrow({
        updateFieldInput,
        workspaceId,
        flatEntityMaps,
        flatApplication: workspaceCustomFlatApplication,
        isSystemBuild: false,
      }),
    );

    const validateAndBuildResult =
      await this.workspaceMigrationValidateBuildAndRunService.validateBuildAndRunWorkspaceMigration(
        {
          allFlatEntityOperationByMetadataName: mergeIndependentFieldOperations(
            [
              toFieldCreateOperations(createOperations),
              ...updateTranspilations.map(toFieldUpdateOperations),
            ],
          ),
          workspaceId,
          isSystemBuild: false,
          applicationUniversalIdentifier:
            workspaceCustomFlatApplication.universalIdentifier,
        },
      );

    if (validateAndBuildResult.status === 'fail') {
      throw new WorkspaceMigrationBuilderException(
        validateAndBuildResult,
        'Multiple validation errors occurred while creating and updating fields',
      );
    }

    const { flatFieldMetadataMaps: recomputedFlatFieldMetadataMaps } =
      await this.flatEntityMapsCacheService.getOrRecomputeManyOrAllFlatEntityMaps(
        {
          workspaceId,
          flatMapsKeys: ['flatFieldMetadataMaps'],
        },
      );

    return {
      created:
        findManyFlatEntityByUniversalIdentifierInUniversalFlatEntityMapsOrThrow(
          {
            universalIdentifiers: createTranspilations.map(
              ({ result: { flatFieldMetadatas } }) =>
                flatFieldMetadatas[0].universalIdentifier,
            ),
            flatEntityMaps: recomputedFlatFieldMetadataMaps,
          },
        ),
      updated:
        findManyFlatEntityByUniversalIdentifierInUniversalFlatEntityMapsOrThrow(
          {
            universalIdentifiers: updateTranspilations.map(
              ({ flatFieldMetadatasToUpdate }) =>
                flatFieldMetadatasToUpdate[0].universalIdentifier,
            ),
            flatEntityMaps: recomputedFlatFieldMetadataMaps,
          },
        ),
    };
  }

  private async getFieldUpdateFlatEntityMaps(workspaceId: string) {
    return this.flatEntityMapsCacheService.getOrRecomputeManyOrAllFlatEntityMaps(
      {
        workspaceId,
        flatMapsKeys: [
          'flatObjectMetadataMaps',
          'flatIndexMaps',
          'flatFieldMetadataMaps',
          'flatViewFilterMaps',
          'flatViewGroupMaps',
          'flatViewMaps',
          'flatViewFieldMaps',
        ],
      },
    );
  }

  private transpileUpdateFieldInputOrThrow({
    updateFieldInput,
    workspaceId,
    flatEntityMaps,
    flatApplication,
    isSystemBuild,
  }: {
    updateFieldInput: Omit<UpdateFieldInput, 'workspaceId'>;
    workspaceId: string;
    flatEntityMaps: Awaited<
      ReturnType<FieldMetadataService['getFieldUpdateFlatEntityMaps']>
    >;
    flatApplication: FlatApplication;
    isSystemBuild: boolean;
  }): FieldUpdateTranspilation {
    const inputTranspilationResult = fromUpdateFieldInputToFlatFieldMetadata({
      flatFieldMetadataMaps: flatEntityMaps.flatFieldMetadataMaps,
      flatIndexMaps: flatEntityMaps.flatIndexMaps,
      flatObjectMetadataMaps: flatEntityMaps.flatObjectMetadataMaps,
      updateFieldInput: { ...updateFieldInput, workspaceId },
      flatViewFilterMaps: flatEntityMaps.flatViewFilterMaps,
      flatViewGroupMaps: flatEntityMaps.flatViewGroupMaps,
      flatViewMaps: flatEntityMaps.flatViewMaps,
      flatViewFieldMaps: flatEntityMaps.flatViewFieldMaps,
      flatApplication,
      isSystemBuild,
    });

    if (inputTranspilationResult.status === 'fail') {
      throw new WorkspaceMigrationBuilderException(
        {
          report: {
            ...EMPTY_ORCHESTRATOR_FAILURE_REPORT(),
            fieldMetadata: [
              {
                errors: inputTranspilationResult.errors,
                type: 'update',
                metadataName: 'fieldMetadata',
                flatEntityMinimalInformation: {
                  id: '',
                },
              },
            ],
          },
          status: 'fail',
        },
        'Validation errors occurred while updating field',
      );
    }

    return inputTranspilationResult.result;
  }

  async createManyFields({
    createFieldInputs,
    workspaceId,
    ownerFlatApplication,
    isSystemBuild = false,
  }: {
    createFieldInputs: Omit<CreateFieldInput, 'workspaceId'>[];
    workspaceId: string;
    ownerFlatApplication?: FlatApplication;
    isSystemBuild?: boolean;
  }): Promise<FlatFieldMetadata[]> {
    if (createFieldInputs.length === 0) {
      return [];
    }

    const resolvedOwnerFlatApplication =
      ownerFlatApplication ??
      (
        await this.applicationService.findWorkspaceTwentyStandardAndCustomApplicationOrThrow(
          { workspaceId },
        )
      ).workspaceCustomFlatApplication;

    const {
      flatObjectMetadataMaps: existingFlatObjectMetadataMaps,
      flatFieldMetadataMaps: existingFlatFieldMetadataMaps,
    } = await this.workspaceCacheService.getOrRecompute(workspaceId, [
      'flatObjectMetadataMaps',
      'flatFieldMetadataMaps',
    ]);

    const {
      transpilations: allTranspiledTranspilationInputs,
      flatFieldMetadatasToCreate,
      flatIndexMetadatasToCreate,
    } = await this.transpileCreateFieldInputsOrThrow({
      createFieldInputs,
      flatObjectMetadataMaps: existingFlatObjectMetadataMaps,
      flatFieldMetadataMaps: existingFlatFieldMetadataMaps,
      flatApplication: resolvedOwnerFlatApplication,
    });

    await this.assertPhoneSearchAvailableForCreatedFields({
      workspaceId,
      flatObjectMetadataMaps: existingFlatObjectMetadataMaps,
      flatFieldMetadatasToCreate,
    });

    const validateAndBuildResult =
      await this.workspaceMigrationValidateBuildAndRunService.validateBuildAndRunWorkspaceMigration(
        {
          allFlatEntityOperationByMetadataName: {
            fieldMetadata: {
              flatEntityToCreate: flatFieldMetadatasToCreate,
              flatEntityToDelete: [],
              flatEntityToUpdate: [],
            },
            index: {
              flatEntityToCreate: flatIndexMetadatasToCreate,
              flatEntityToDelete: [],
              flatEntityToUpdate: [],
            },
          },
          workspaceId,
          isSystemBuild,
          applicationUniversalIdentifier:
            resolvedOwnerFlatApplication.universalIdentifier,
        },
      );

    if (validateAndBuildResult.status === 'fail') {
      throw new WorkspaceMigrationBuilderException(
        validateAndBuildResult,
        'Multiple validation errors occurred while creating fields',
      );
    }

    const { flatFieldMetadataMaps: recomputedFlatFieldMetadataMaps } =
      await this.flatEntityMapsCacheService.getOrRecomputeManyOrAllFlatEntityMaps(
        {
          workspaceId,
          flatMapsKeys: ['flatFieldMetadataMaps'],
        },
      );

    return findManyFlatEntityByUniversalIdentifierInUniversalFlatEntityMapsOrThrow(
      {
        universalIdentifiers: allTranspiledTranspilationInputs.map(
          ({ result: { flatFieldMetadatas } }) =>
            flatFieldMetadatas[0].universalIdentifier,
        ),
        flatEntityMaps: recomputedFlatFieldMetadataMaps,
      },
    );
  }

  private async transpileCreateFieldInputsOrThrow({
    createFieldInputs,
    flatObjectMetadataMaps,
    flatFieldMetadataMaps,
    flatApplication,
  }: {
    createFieldInputs: Omit<CreateFieldInput, 'workspaceId'>[];
    flatObjectMetadataMaps: CreateFieldTranspilationArgs['flatObjectMetadataMaps'];
    flatFieldMetadataMaps: CreateFieldTranspilationArgs['flatFieldMetadataMaps'];
    flatApplication: FlatApplication;
  }) {
    const transpilations: Awaited<
      ReturnType<typeof fromCreateFieldInputToFlatFieldMetadatasToCreate>
    >[] = [];

    for (const createFieldInput of createFieldInputs) {
      transpilations.push(
        await fromCreateFieldInputToFlatFieldMetadatasToCreate({
          flatObjectMetadataMaps,
          flatFieldMetadataMaps,
          createFieldInput,
          flatApplication,
        }),
      );
    }

    throwOnFieldInputTranspilationsError(
      transpilations,
      'Multiple validation errors occurred while creating field',
    );

    return {
      transpilations,
      flatFieldMetadatasToCreate: transpilations.flatMap(
        ({ result }) => result.flatFieldMetadatas,
      ),
      flatIndexMetadatasToCreate: transpilations.flatMap(
        ({ result }) => result.indexMetadatas,
      ),
    };
  }

  private async assertPhoneSearchAvailableForCreatedFields({
    workspaceId,
    flatObjectMetadataMaps,
    flatFieldMetadatasToCreate,
  }: {
    workspaceId: string;
    flatObjectMetadataMaps: CreateFieldTranspilationArgs['flatObjectMetadataMaps'];
    flatFieldMetadatasToCreate: UniversalFlatFieldMetadata[];
  }): Promise<void> {
    const person =
      flatObjectMetadataMaps.byUniversalIdentifier[
        STANDARD_OBJECTS.person.universalIdentifier
      ];

    if (
      person &&
      flatFieldMetadatasToCreate.some(
        (field) =>
          field.type === FieldMetadataType.PHONES &&
          field.objectMetadataUniversalIdentifier ===
            person.universalIdentifier,
      )
    ) {
      await this.phoneSearchMetadataGateService?.assertAvailable({
        workspaceId,
        objectMetadataId: person.id,
      });
    }
  }

  public async findOneWithinWorkspace(
    workspaceId: string,
    options: FindOneOptions<FieldMetadataEntity>,
  ) {
    const [fieldMetadata] = await this.fieldMetadataRepository.find({
      ...options,
      where: {
        ...options.where,
        workspaceId,
      },
    });

    return fieldMetadata;
  }
}
