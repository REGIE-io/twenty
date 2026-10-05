import { Injectable } from '@nestjs/common';

import { FieldMetadataType } from 'twenty-shared/types';
import { isDefined } from 'twenty-shared/utils';

import {
  dropSearchVectorTrigger,
  findSearchVectorTriggerSource,
  refreshSearchVectorTriggerIfConverted,
} from 'src/engine/core-modules/search-vector-trigger/utils/search-vector-trigger-maintenance.util';
import { WorkspaceMigrationRunnerActionHandler } from 'src/engine/workspace-manager/workspace-migration/workspace-migration-runner/interfaces/workspace-migration-runner-action-handler-service.interface';

import { FieldMetadataEntity } from 'src/engine/metadata-modules/field-metadata/field-metadata.entity';
import { findFlatEntityByIdInFlatEntityMapsOrThrow } from 'src/engine/metadata-modules/flat-entity/utils/find-flat-entity-by-id-in-flat-entity-maps-or-throw.util';
import { isFlatFieldMetadataOfType } from 'src/engine/metadata-modules/flat-field-metadata/utils/is-flat-field-metadata-of-type.util';
import { WorkspaceSchemaManagerService } from 'src/engine/twenty-orm/workspace-schema-manager/workspace-schema-manager.service';
import {
  type FlatDeleteFieldAction,
  type UniversalDeleteFieldAction,
} from 'src/engine/workspace-manager/workspace-migration/workspace-migration-builder/builders/field/types/workspace-migration-field-action';
import {
  type WorkspaceMigrationActionRunnerArgs,
  type WorkspaceMigrationActionRunnerContext,
} from 'src/engine/workspace-manager/workspace-migration/workspace-migration-runner/types/workspace-migration-action-runner-args.type';
import { generateColumnDefinitions } from 'src/engine/workspace-manager/workspace-migration/workspace-migration-runner/utils/generate-column-definitions.util';
import { getWorkspaceSchemaContextForMigration } from 'src/engine/workspace-manager/workspace-migration/workspace-migration-runner/utils/get-workspace-schema-context-for-migration.util';
import {
  collectEnumOperationsForField,
  EnumOperation,
  executeBatchEnumOperations,
} from 'src/engine/workspace-manager/workspace-migration/workspace-migration-runner/utils/workspace-schema-enum-operations.util';

@Injectable()
export class DeleteFieldActionHandlerService extends WorkspaceMigrationRunnerActionHandler(
  'delete',
  'fieldMetadata',
) {
  constructor(
    private readonly workspaceSchemaManagerService: WorkspaceSchemaManagerService,
  ) {
    super();
  }

  override async transpileUniversalActionToFlatAction(
    context: WorkspaceMigrationActionRunnerArgs<UniversalDeleteFieldAction>,
  ): Promise<FlatDeleteFieldAction> {
    return this.transpileUniversalDeleteActionToFlatDeleteAction(context);
  }

  async executeForMetadata(
    context: WorkspaceMigrationActionRunnerContext<FlatDeleteFieldAction>,
  ) {
    const { flatAction, queryRunner, workspaceId } = context;

    const fieldMetadataRepository =
      queryRunner.manager.getRepository<FieldMetadataEntity>(
        FieldMetadataEntity,
      );

    await fieldMetadataRepository.delete({
      id: flatAction.entityId,
      workspaceId,
    });
  }

  async executeForWorkspaceSchema(
    context: WorkspaceMigrationActionRunnerContext<FlatDeleteFieldAction>,
  ) {
    const {
      flatAction,
      queryRunner,
      allFlatEntityMaps: {
        flatObjectMetadataMaps,
        flatFieldMetadataMaps,
        flatSearchFieldMetadataMaps,
      },
      workspaceId,
      getSearchFieldMetadatasByTsVectorFieldId,
      objectUniversalIdentifiersBeingDeleted,
    } = context;

    const flatFieldMetadata = findFlatEntityByIdInFlatEntityMapsOrThrow({
      flatEntityMaps: flatFieldMetadataMaps,
      flatEntityId: flatAction.entityId,
    });

    const flatObjectMetadata = findFlatEntityByIdInFlatEntityMapsOrThrow({
      flatEntityMaps: flatObjectMetadataMaps,
      flatEntityId: flatFieldMetadata.objectMetadataId,
    });

    const { schemaName, tableName } = getWorkspaceSchemaContextForMigration({
      workspaceId,
      objectMetadata: flatObjectMetadata,
    });

    const columnDefinitions = generateColumnDefinitions({
      flatFieldMetadata,
      flatObjectMetadata,
      workspaceId,
    });
    const columnNamesToDrop = columnDefinitions.map((def) => def.name);

    await this.workspaceSchemaManagerService.columnManager.dropColumns({
      queryRunner,
      schemaName,
      tableName,
      columnNames: columnNamesToDrop,
      cascade: true,
    });

    if (
      isFlatFieldMetadataOfType(flatFieldMetadata, FieldMetadataType.TS_VECTOR)
    ) {
      await dropSearchVectorTrigger(queryRunner, { schemaName, tableName });
    }

    // A converted table's function still reads the dropped column; skipped when the table is being dropped.
    const isObjectBeingDeleted =
      objectUniversalIdentifiersBeingDeleted?.has(
        flatObjectMetadata.universalIdentifier,
      ) ?? false;

    const searchVectorTriggerSource = isObjectBeingDeleted
      ? undefined
      : findSearchVectorTriggerSource({
          queryRunner,
          schemaName,
          tableName,
          flatObjectMetadata,
          flatFieldMetadataMaps,
          flatSearchFieldMetadataMaps,
          getSearchFieldMetadatasByTsVectorFieldId,
          deletedFieldMetadataId: flatFieldMetadata.id,
        });

    if (isDefined(searchVectorTriggerSource)) {
      await refreshSearchVectorTriggerIfConverted(searchVectorTriggerSource);
    }

    const enumOperations = collectEnumOperationsForField({
      flatFieldMetadata,
      tableName,
      operation: EnumOperation.DROP,
    });

    await executeBatchEnumOperations({
      enumOperations,
      queryRunner,
      schemaName,
      workspaceSchemaManagerService: this.workspaceSchemaManagerService,
    });
  }
}
