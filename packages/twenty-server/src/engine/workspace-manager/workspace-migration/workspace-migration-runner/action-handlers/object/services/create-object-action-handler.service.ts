import { Injectable } from '@nestjs/common';

import { FieldMetadataType } from 'twenty-shared/types';
import { isDefined } from 'twenty-shared/utils';
import { type QueryRunner } from 'typeorm';
import { v4 } from 'uuid';

import { WorkspaceMigrationRunnerActionHandler } from 'src/engine/workspace-manager/workspace-migration/workspace-migration-runner/interfaces/workspace-migration-runner-action-handler-service.interface';

import { reinstallSearchVectorTrigger } from 'src/engine/core-modules/search-vector-trigger/utils/search-vector-trigger-maintenance.util';
import { ALL_METADATA_ENTITY_BY_METADATA_NAME } from 'src/engine/metadata-modules/flat-entity/constant/all-metadata-entity-by-metadata-name.constant';
import { isCompositeFlatFieldMetadata } from 'src/engine/metadata-modules/flat-field-metadata/utils/is-composite-flat-field-metadata.util';
import { isEnumFlatFieldMetadata } from 'src/engine/metadata-modules/flat-field-metadata/utils/is-enum-flat-field-metadata.util';
import { isFlatFieldMetadataOfType } from 'src/engine/metadata-modules/flat-field-metadata/utils/is-flat-field-metadata-of-type.util';
import { deriveCheckedSearchVectorExpression } from 'src/engine/metadata-modules/flat-search-field-metadata/utils/derive-checked-search-vector-expression.util';
import { getTargetSearchFieldMetadatasForTsVectorField } from 'src/engine/metadata-modules/flat-search-field-metadata/utils/get-target-search-field-metadatas-for-ts-vector-field.util';
import { WorkspaceSchemaManagerService } from 'src/engine/twenty-orm/workspace-schema-manager/workspace-schema-manager.service';
import { ensureParticipantHandleIndex } from 'src/engine/workspace-manager/workspace-migration/workspace-migration-runner/action-handlers/object/utils/ensure-participant-handle-index.util';
import {
  FlatCreateObjectAction,
  UniversalCreateObjectAction,
} from 'src/engine/workspace-manager/workspace-migration/workspace-migration-builder/builders/object/types/workspace-migration-object-action';
import { fromUniversalFlatFieldMetadataToFlatFieldMetadata } from 'src/engine/workspace-manager/workspace-migration/workspace-migration-runner/action-handlers/field/services/utils/from-universal-flat-field-metadata-to-flat-field-metadata.util';
import { fromUniversalFlatObjectMetadataToFlatObjectMetadata } from 'src/engine/workspace-manager/workspace-migration/workspace-migration-runner/action-handlers/object/services/utils/from-universal-flat-object-metadata-to-flat-object-metadata.util';
import {
  type WorkspaceMigrationActionRunnerArgs,
  WorkspaceMigrationActionRunnerContext,
} from 'src/engine/workspace-manager/workspace-migration/workspace-migration-runner/types/workspace-migration-action-runner-args.type';
import { flatEntityToScalarFlatEntity } from 'src/engine/workspace-manager/workspace-migration/workspace-migration-runner/utils/flat-entity-to-scalar-flat-entity.util';
import { generateColumnDefinitions } from 'src/engine/workspace-manager/workspace-migration/workspace-migration-runner/utils/generate-column-definitions.util';
import { getWorkspaceSchemaContextForMigration } from 'src/engine/workspace-manager/workspace-migration/workspace-migration-runner/utils/get-workspace-schema-context-for-migration.util';
import {
  collectEnumOperationsForObject,
  EnumOperation,
  executeBatchEnumOperations,
} from 'src/engine/workspace-manager/workspace-migration/workspace-migration-runner/utils/workspace-schema-enum-operations.util';

@Injectable()
export class CreateObjectActionHandlerService extends WorkspaceMigrationRunnerActionHandler(
  'create',
  'objectMetadata',
) {
  constructor(
    private readonly workspaceSchemaManagerService: WorkspaceSchemaManagerService,
  ) {
    super();
  }

  override async transpileUniversalActionToFlatAction(
    context: WorkspaceMigrationActionRunnerArgs<UniversalCreateObjectAction>,
  ): Promise<FlatCreateObjectAction> {
    const { action, allFlatEntityMaps } = context;
    const { fieldIdByUniversalIdentifier, id: providedObjectId } = action;

    const allFieldIdToBeCreatedInActionByUniversalIdentifierMap = new Map<
      string,
      string
    >();

    for (const universalFlatFieldMetadata of action.universalFlatFieldMetadatas) {
      const providedFieldId =
        fieldIdByUniversalIdentifier?.[
          universalFlatFieldMetadata.universalIdentifier
        ];

      allFieldIdToBeCreatedInActionByUniversalIdentifierMap.set(
        universalFlatFieldMetadata.universalIdentifier,
        providedFieldId ?? v4(),
      );
    }

    const flatObjectMetadata =
      fromUniversalFlatObjectMetadataToFlatObjectMetadata({
        allFieldIdToBeCreatedInActionByUniversalIdentifierMap,
        allFlatEntityMaps,
        context,
        generatedId: providedObjectId ?? v4(),
        universalFlatObjectMetadata: action.flatEntity,
      });

    const flatFieldMetadatas = action.universalFlatFieldMetadatas.map(
      (universalFlatFieldMetadata) =>
        fromUniversalFlatFieldMetadataToFlatFieldMetadata({
          objectMetadataId: flatObjectMetadata.id,
          universalFlatFieldMetadata,
          allFieldIdToBeCreatedInActionByUniversalIdentifierMap,
          allFlatEntityMaps,
          context,
        }),
    );

    return {
      type: action.type,
      metadataName: action.metadataName,
      flatEntity: flatObjectMetadata,
      flatFieldMetadatas,
    };
  }

  override canBatchCreate = true;

  async executeForMetadata(
    context: WorkspaceMigrationActionRunnerContext<FlatCreateObjectAction>,
  ): Promise<void> {
    await this.executeForMetadataBatch([context]);
  }

  override async executeForMetadataBatch(
    contexts: WorkspaceMigrationActionRunnerContext<FlatCreateObjectAction>[],
  ): Promise<void> {
    if (contexts.length === 0) {
      return;
    }

    const { queryRunner } = contexts[0];

    await this.insertFlatEntitiesInRepository({
      queryRunner,
      flatEntities: contexts.map((context) => context.flatAction.flatEntity),
    });

    const scalarFieldMetadatas = contexts.flatMap((context) =>
      context.flatAction.flatFieldMetadatas.map((flatFieldMetadata) =>
        flatEntityToScalarFlatEntity({
          metadataName: 'fieldMetadata',
          flatEntity: flatFieldMetadata,
        }),
      ),
    );

    if (scalarFieldMetadatas.length === 0) {
      return;
    }

    await queryRunner.manager
      .getRepository(ALL_METADATA_ENTITY_BY_METADATA_NAME['fieldMetadata'])
      .insert(scalarFieldMetadatas);
  }

  async executeForWorkspaceSchema(
    context: WorkspaceMigrationActionRunnerContext<FlatCreateObjectAction>,
  ): Promise<void> {
    const { queryRunner, workspaceId, flatAction } = context;
    const tableDefinition = this.buildCreateTableDefinition(context);
    const { schemaName, tableName, columnDefinitions, enumOperations } =
      tableDefinition;

    await executeBatchEnumOperations({
      enumOperations,
      queryRunner,
      schemaName,
      workspaceSchemaManagerService: this.workspaceSchemaManagerService,
    });

    await this.workspaceSchemaManagerService.tableManager.createTable({
      queryRunner,
      schemaName,
      tableName,
      columnDefinitions,
    });

    await this.installSearchVectorTriggerIfConverted(
      queryRunner,
      tableDefinition,
    );

    await ensureParticipantHandleIndex({
      queryRunner,
      workspaceId,
      objectMetadata: flatAction.flatEntity,
    });
  }

  override async executeForWorkspaceSchemaBatch(
    contexts: WorkspaceMigrationActionRunnerContext<FlatCreateObjectAction>[],
  ): Promise<void> {
    if (contexts.length === 0) {
      return;
    }

    const { queryRunner, workspaceId } = contexts[0];
    const tableDefinitions = contexts.map((context) =>
      this.buildCreateTableDefinition(context),
    );
    const { schemaName } = tableDefinitions[0];

    await executeBatchEnumOperations({
      enumOperations: tableDefinitions.flatMap(
        (tableDefinition) => tableDefinition.enumOperations,
      ),
      queryRunner,
      schemaName,
      workspaceSchemaManagerService: this.workspaceSchemaManagerService,
    });

    await this.workspaceSchemaManagerService.tableManager.createTables({
      queryRunner,
      schemaName,
      tables: tableDefinitions.map(({ tableName, columnDefinitions }) => ({
        tableName,
        columnDefinitions,
      })),
    });

    for (const tableDefinition of tableDefinitions) {
      await this.installSearchVectorTriggerIfConverted(
        queryRunner,
        tableDefinition,
      );
    }

    for (const context of contexts) {
      await ensureParticipantHandleIndex({
        queryRunner,
        workspaceId,
        objectMetadata: context.flatAction.flatEntity,
      });
    }
  }

  private async installSearchVectorTriggerIfConverted(
    queryRunner: QueryRunner,
    {
      schemaName,
      tableName,
      searchVectorTrigger,
    }: ReturnType<
      CreateObjectActionHandlerService['buildCreateTableDefinition']
    >,
  ): Promise<void> {
    if (!isDefined(searchVectorTrigger)) {
      return;
    }

    await reinstallSearchVectorTrigger({
      queryRunner,
      schemaName,
      tableName,
      ...searchVectorTrigger,
    });
  }

  // Both paths build their tables here: the batched path once skipped the searchVector
  // expression, which creates a tsvector column that is never populated.
  private buildCreateTableDefinition(
    context: WorkspaceMigrationActionRunnerContext<FlatCreateObjectAction>,
  ) {
    const {
      flatAction,
      workspaceId,
      allFlatEntityMaps,
      getSearchFieldMetadatasByTsVectorFieldId,
      isSearchVectorTriggerEnabled,
    } = context;
    const { flatEntity: flatObjectMetadata, flatFieldMetadatas } = flatAction;

    const { schemaName, tableName } = getWorkspaceSchemaContextForMigration({
      workspaceId,
      objectMetadata: flatObjectMetadata,
    });

    const findTargetSearchFieldMetadatas = (tsVectorFieldMetadataId: string) =>
      getSearchFieldMetadatasByTsVectorFieldId?.(tsVectorFieldMetadataId) ??
      getTargetSearchFieldMetadatasForTsVectorField({
        tsVectorFieldMetadataId,
        flatSearchFieldMetadataMaps:
          allFlatEntityMaps.flatSearchFieldMetadataMaps,
      });

    const tsVectorFlatFieldMetadata = flatFieldMetadatas.find(
      (flatFieldMetadata) =>
        isFlatFieldMetadataOfType(
          flatFieldMetadata,
          FieldMetadataType.TS_VECTOR,
        ),
    );

    const columnDefinitions = flatFieldMetadatas.flatMap(
      (flatFieldMetadata) => {
        const isTsVectorField = isFlatFieldMetadataOfType(
          flatFieldMetadata,
          FieldMetadataType.TS_VECTOR,
        );
        // In a converted workspace the column stays plain and a trigger fills it.
        const isFilledByTrigger =
          isTsVectorField && isSearchVectorTriggerEnabled === true;

        return generateColumnDefinitions({
          flatFieldMetadata,
          flatObjectMetadata,
          workspaceId,
          searchVectorAsExpression:
            isTsVectorField && !isFilledByTrigger
              ? deriveCheckedSearchVectorExpression({
                  flatObjectMetadata,
                  objectFlatFieldMetadatas: flatFieldMetadatas,
                  targetSearchFieldMetadatas: findTargetSearchFieldMetadatas(
                    flatFieldMetadata.id,
                  ),
                })
              : undefined,
        }).map((columnDefinition) =>
          isFilledByTrigger
            ? { ...columnDefinition, isFilledByTrigger }
            : columnDefinition,
        );
      },
    );

    const enumOrCompositeFlatFieldMetadatas = flatFieldMetadatas.filter(
      (flatFieldMetadata) =>
        isEnumFlatFieldMetadata(flatFieldMetadata) ||
        isCompositeFlatFieldMetadata(flatFieldMetadata),
    );

    const enumOperations = collectEnumOperationsForObject({
      flatFieldMetadatas: enumOrCompositeFlatFieldMetadatas,
      tableName,
      operation: EnumOperation.CREATE,
    });

    // In a converted workspace the column is plain, so the table needs its trigger at creation.
    const searchVectorTrigger =
      isSearchVectorTriggerEnabled && isDefined(tsVectorFlatFieldMetadata)
        ? {
            flatObjectMetadata,
            objectFlatFieldMetadatas: flatFieldMetadatas,
            targetSearchFieldMetadatas: findTargetSearchFieldMetadatas(
              tsVectorFlatFieldMetadata.id,
            ),
          }
        : undefined;

    return {
      schemaName,
      tableName,
      columnDefinitions,
      enumOperations,
      searchVectorTrigger,
    };
  }
}
