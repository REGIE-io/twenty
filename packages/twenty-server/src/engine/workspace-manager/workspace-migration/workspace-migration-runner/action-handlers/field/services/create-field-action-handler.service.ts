import { Injectable } from '@nestjs/common';

import { FieldMetadataType, RelationType } from 'twenty-shared/types';
import { isDefined } from 'twenty-shared/utils';
import { type QueryRunner } from 'typeorm';
import { v4 } from 'uuid';

import { buildManyToOneForeignKeyDefinition } from 'src/engine/workspace-manager/workspace-migration/workspace-migration-runner/action-handlers/field/services/utils/build-many-to-one-foreign-key-definition.util';
import { getDeferredForeignKeyValidation } from 'src/engine/workspace-manager/workspace-migration/workspace-migration-runner/action-handlers/field/services/utils/get-deferred-foreign-key-validation.util';
import { WorkspaceMigrationRunnerActionHandler } from 'src/engine/workspace-manager/workspace-migration/workspace-migration-runner/interfaces/workspace-migration-runner-action-handler-service.interface';

import { type FlatEntityMaps } from 'src/engine/metadata-modules/flat-entity/types/flat-entity-maps.type';
import { type MetadataFlatEntityMaps } from 'src/engine/metadata-modules/flat-entity/types/metadata-flat-entity-maps.type';
import { findFlatEntityByIdInFlatEntityMapsOrThrow } from 'src/engine/metadata-modules/flat-entity/utils/find-flat-entity-by-id-in-flat-entity-maps-or-throw.util';
import { findManyFlatEntityByIdInFlatEntityMaps } from 'src/engine/metadata-modules/flat-entity/utils/find-many-flat-entity-by-id-in-flat-entity-maps.util';
import { type FlatFieldMetadata } from 'src/engine/metadata-modules/flat-field-metadata/types/flat-field-metadata.type';
import { isFlatFieldMetadataOfType } from 'src/engine/metadata-modules/flat-field-metadata/utils/is-flat-field-metadata-of-type.util';
import { isMorphOrRelationFlatFieldMetadata } from 'src/engine/metadata-modules/flat-field-metadata/utils/is-morph-or-relation-flat-field-metadata.util';
import { type FlatSearchFieldMetadata } from 'src/engine/metadata-modules/flat-search-field-metadata/types/flat-search-field-metadata.type';
import { resolveSearchVectorAsExpressionForTsVectorField } from 'src/engine/metadata-modules/flat-search-field-metadata/utils/resolve-search-vector-as-expression-for-ts-vector-field.util';
import { WorkspaceSchemaManagerService } from 'src/engine/twenty-orm/workspace-schema-manager/workspace-schema-manager.service';
import {
  type FlatCreateFieldAction,
  type UniversalCreateFieldAction,
} from 'src/engine/workspace-manager/workspace-migration/workspace-migration-builder/builders/field/types/workspace-migration-field-action.type';
import { fromUniversalFlatFieldMetadataToFlatFieldMetadata } from 'src/engine/workspace-manager/workspace-migration/workspace-migration-runner/action-handlers/field/services/utils/from-universal-flat-field-metadata-to-flat-field-metadata.util';
import {
  WorkspaceMigrationActionRunnerContext,
  type WorkspaceMigrationActionRunnerArgs,
} from 'src/engine/workspace-manager/workspace-migration/workspace-migration-runner/types/workspace-migration-action-runner-args.type';
import { generateColumnDefinitions } from 'src/engine/workspace-manager/workspace-migration/workspace-migration-runner/utils/generate-column-definitions.util';
import { getWorkspaceSchemaContextForMigration } from 'src/engine/workspace-manager/workspace-migration/workspace-migration-runner/utils/get-workspace-schema-context-for-migration.util';
import {
  collectEnumOperationsForField,
  EnumOperation,
  executeBatchEnumOperations,
} from 'src/engine/workspace-manager/workspace-migration/workspace-migration-runner/utils/workspace-schema-enum-operations.util';

@Injectable()
export class CreateFieldActionHandlerService extends WorkspaceMigrationRunnerActionHandler(
  'create',
  'fieldMetadata',
) {
  constructor(
    private readonly workspaceSchemaManagerService: WorkspaceSchemaManagerService,
  ) {
    super();
  }

  override async transpileUniversalActionToFlatAction(
    context: WorkspaceMigrationActionRunnerArgs<UniversalCreateFieldAction>,
  ): Promise<FlatCreateFieldAction> {
    const { action, allFlatEntityMaps } = context;

    const allFieldIdToBeCreatedInActionByUniversalIdentifierMap = new Map<
      string,
      string
    >(Object.entries(action.fieldIdByUniversalIdentifier ?? {}));

    if (
      !allFieldIdToBeCreatedInActionByUniversalIdentifierMap.has(
        action.flatEntity.universalIdentifier,
      )
    ) {
      allFieldIdToBeCreatedInActionByUniversalIdentifierMap.set(
        action.flatEntity.universalIdentifier,
        action.id ?? v4(),
      );
    }

    if (
      isDefined(action.relatedUniversalFlatFieldMetadata) &&
      !allFieldIdToBeCreatedInActionByUniversalIdentifierMap.has(
        action.relatedUniversalFlatFieldMetadata.universalIdentifier,
      )
    ) {
      allFieldIdToBeCreatedInActionByUniversalIdentifierMap.set(
        action.relatedUniversalFlatFieldMetadata.universalIdentifier,
        action.relatedFieldId ?? v4(),
      );
    }

    const universalFlatFieldMetadatas = isDefined(
      action.relatedUniversalFlatFieldMetadata,
    )
      ? [action.flatEntity, action.relatedUniversalFlatFieldMetadata]
      : [action.flatEntity];

    const [flatFieldMetadata, relatedFlatFieldMetadata] =
      universalFlatFieldMetadatas.map((universalFlatFieldMetadata) =>
        fromUniversalFlatFieldMetadataToFlatFieldMetadata({
          universalFlatFieldMetadata,
          allFieldIdToBeCreatedInActionByUniversalIdentifierMap,
          allFlatEntityMaps,
          context,
        }),
      );

    return {
      type: action.type,
      metadataName: action.metadataName,
      flatEntity: flatFieldMetadata,
      relatedFlatFieldMetadata,
    };
  }

  override canBatchCreate = true;

  async executeForMetadata(
    context: WorkspaceMigrationActionRunnerContext<FlatCreateFieldAction>,
  ): Promise<void> {
    const { queryRunner, flatAction } = context;
    const { flatEntity, relatedFlatFieldMetadata } = flatAction;

    await this.insertFlatEntitiesInRepository({
      queryRunner,
      flatEntities: [flatEntity, relatedFlatFieldMetadata].filter(isDefined),
    });
  }

  override async executeForMetadataBatch(
    contexts: WorkspaceMigrationActionRunnerContext<FlatCreateFieldAction>[],
  ): Promise<void> {
    if (contexts.length === 0) {
      return;
    }

    const flatEntities = contexts.flatMap((context) =>
      [
        context.flatAction.flatEntity,
        context.flatAction.relatedFlatFieldMetadata,
      ].filter(isDefined),
    );

    await this.insertFlatEntitiesInRepository({
      queryRunner: contexts[0].queryRunner,
      flatEntities,
    });
  }

  async executeForWorkspaceSchema(
    context: WorkspaceMigrationActionRunnerContext<FlatCreateFieldAction>,
  ): Promise<void> {
    await this.executeForWorkspaceSchemaBatch([context]);
  }

  override async executeForWorkspaceSchemaBatch(
    contexts: WorkspaceMigrationActionRunnerContext<FlatCreateFieldAction>[],
  ): Promise<void> {
    if (contexts.length === 0) return;
    const {
      queryRunner,
      workspaceId,
      allFlatEntityMaps: {
        flatObjectMetadataMaps,
        flatFieldMetadataMaps,
        flatSearchFieldMetadataMaps,
      },
      getSearchFieldMetadatasByTsVectorFieldId,
    } = contexts[0];
    const deferredFieldIds = new Set(
      contexts.flatMap((context) => {
        const deferred = getDeferredForeignKeyValidation(context);
        return deferred ? [deferred.payload.fieldMetadataId] : [];
      }),
    );
    const fieldsByObject = new Map<string, FlatFieldMetadata[]>();
    for (const context of contexts) {
      for (const field of [
        context.flatAction.flatEntity,
        context.flatAction.relatedFlatFieldMetadata,
      ].filter(isDefined)) {
        const fields = fieldsByObject.get(field.objectMetadataId) ?? [];
        fields.push(field);
        fieldsByObject.set(field.objectMetadataId, fields);
      }
    }
    for (const [objectMetadataId, createdFields] of fieldsByObject) {
      const flatObjectMetadata = findFlatEntityByIdInFlatEntityMapsOrThrow({
        flatEntityMaps: flatObjectMetadataMaps,
        flatEntityId: objectMetadataId,
      });
      const { schemaName, tableName } = getWorkspaceSchemaContextForMigration({
        workspaceId,
        objectMetadata: flatObjectMetadata,
      });
      const objectFlatFieldMetadatas = [
        ...findManyFlatEntityByIdInFlatEntityMaps({
          flatEntityMaps: flatFieldMetadataMaps,
          flatEntityIds: flatObjectMetadata.fieldIds,
        }),
        ...createdFields,
      ];
      const enumOperations = createdFields.flatMap((flatFieldMetadata) =>
        collectEnumOperationsForField({
          flatFieldMetadata,
          tableName,
          operation: EnumOperation.CREATE,
        }),
      );
      await executeBatchEnumOperations({
        enumOperations,
        queryRunner,
        schemaName,
        workspaceSchemaManagerService: this.workspaceSchemaManagerService,
      });
      const columnDefinitions = createdFields.flatMap((flatFieldMetadata) =>
        generateColumnDefinitions({
          flatFieldMetadata,
          flatObjectMetadata,
          workspaceId,
          searchVectorAsExpression: isFlatFieldMetadataOfType(
            flatFieldMetadata,
            FieldMetadataType.TS_VECTOR,
          )
            ? resolveSearchVectorAsExpressionForTsVectorField({
                tsVectorFieldMetadataId: flatFieldMetadata.id,
                objectFlatFieldMetadatas,
                flatSearchFieldMetadataMaps,
                getSearchFieldMetadatasByTsVectorFieldId,
              })
            : undefined,
        }),
      );
      await this.workspaceSchemaManagerService.columnManager.addColumns({
        queryRunner,
        schemaName,
        tableName,
        columnDefinitions,
      });
      for (const flatFieldMetadata of createdFields) {
        if (
          isMorphOrRelationFlatFieldMetadata(flatFieldMetadata) &&
          flatFieldMetadata.settings.relationType === RelationType.MANY_TO_ONE
        ) {
          await this.workspaceSchemaManagerService.foreignKeyManager.createForeignKey(
            {
              queryRunner,
              schemaName,
              foreignKey: buildManyToOneForeignKeyDefinition({
                flatFieldMetadata,
                flatObjectMetadataMaps,
                tableName,
              }),
              isNotValid: deferredFieldIds.has(flatFieldMetadata.id),
            },
          );
        }
      }
    }
  }

  protected override getDeferredAction(
    context: WorkspaceMigrationActionRunnerContext<FlatCreateFieldAction>,
  ) {
    return getDeferredForeignKeyValidation(context);
  }
}
