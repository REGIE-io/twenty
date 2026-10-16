import { Injectable } from '@nestjs/common';

import { FeatureFlagKey } from 'twenty-shared/types';
import { v4 } from 'uuid';

import { WorkspaceMigrationRunnerActionHandler } from 'src/engine/workspace-manager/workspace-migration/workspace-migration-runner/interfaces/workspace-migration-runner-action-handler-service.interface';

import { findFlatEntityByIdInFlatEntityMapsOrThrow } from 'src/engine/metadata-modules/flat-entity/utils/find-flat-entity-by-id-in-flat-entity-maps-or-throw.util';
import { findManyFlatEntityByIdInFlatEntityMaps } from 'src/engine/metadata-modules/flat-entity/utils/find-many-flat-entity-by-id-in-flat-entity-maps.util';
import { IndexFieldMetadataEntity } from 'src/engine/metadata-modules/index-metadata/index-field-metadata.entity';
import { WorkspaceSchemaManagerService } from 'src/engine/twenty-orm/workspace-schema-manager/workspace-schema-manager.service';
import {
  type FlatCreateIndexAction,
  type UniversalCreateIndexAction,
} from 'src/engine/workspace-manager/workspace-migration/workspace-migration-builder/builders/index/types/workspace-migration-index-action.type';
import { fromUniversalFlatIndexToFlatIndex } from 'src/engine/workspace-manager/workspace-migration/workspace-migration-runner/action-handlers/index/utils/from-universal-flat-index-to-flat-index.util';
import {
  computeFlatIndexFieldColumnNames,
  createIndexInWorkspaceSchema,
} from 'src/engine/workspace-manager/workspace-migration/workspace-migration-runner/action-handlers/index/utils/index-action-handler.utils';
import { isIndexCreationDeferrable } from 'src/engine/workspace-manager/workspace-migration/workspace-migration-runner/action-handlers/index/utils/is-index-creation-deferrable.util';
import {
  type WorkspaceMigrationActionRunnerArgs,
  type WorkspaceMigrationActionRunnerContext,
} from 'src/engine/workspace-manager/workspace-migration/workspace-migration-runner/types/workspace-migration-action-runner-args.type';
import { getWorkspaceSchemaContextForMigration } from 'src/engine/workspace-manager/workspace-migration/workspace-migration-runner/utils/get-workspace-schema-context-for-migration.util';

@Injectable()
export class CreateIndexActionHandlerService extends WorkspaceMigrationRunnerActionHandler(
  'create',
  'index',
) {
  constructor(
    private readonly workspaceSchemaManagerService: WorkspaceSchemaManagerService,
  ) {
    super();
  }

  override async transpileUniversalActionToFlatAction(
    context: WorkspaceMigrationActionRunnerArgs<UniversalCreateIndexAction>,
  ): Promise<FlatCreateIndexAction> {
    const { action, allFlatEntityMaps, workspaceId, flatApplication } = context;

    const flatEntity = fromUniversalFlatIndexToFlatIndex({
      universalFlatIndexMetadata: action.flatEntity,
      indexMetadataId: action.id ?? v4(),
      allFlatEntityMaps,
      workspaceId,
      applicationId: flatApplication.id,
    });

    return {
      type: action.type,
      metadataName: action.metadataName,
      flatEntity,
    };
  }

  override canBatchCreate = true;

  async executeForMetadata(
    context: WorkspaceMigrationActionRunnerContext<FlatCreateIndexAction>,
  ): Promise<void> {
    const { flatAction, queryRunner } = context;
    const { flatEntity: flatIndexMetadata } = flatAction;

    await this.insertFlatEntitiesInRepository({
      queryRunner,
      flatEntities: [flatIndexMetadata],
    });

    const indexFieldMetadataRepository = queryRunner.manager.getRepository(
      IndexFieldMetadataEntity,
    );

    await indexFieldMetadataRepository.insert(
      flatIndexMetadata.flatIndexFieldMetadatas,
    );
  }

  override async executeForMetadataBatch(
    contexts: WorkspaceMigrationActionRunnerContext<FlatCreateIndexAction>[],
  ): Promise<void> {
    if (contexts.length === 0) {
      return;
    }

    const { queryRunner } = contexts[0];

    await this.insertFlatEntitiesInRepository({
      queryRunner,
      flatEntities: contexts.map((context) => context.flatAction.flatEntity),
    });

    const flatIndexFieldMetadatas = contexts.flatMap(
      (context) => context.flatAction.flatEntity.flatIndexFieldMetadatas,
    );

    if (flatIndexFieldMetadatas.length > 0) {
      await queryRunner.manager
        .getRepository(IndexFieldMetadataEntity)
        .insert(flatIndexFieldMetadatas);
    }
  }

  async executeForWorkspaceSchema(
    context: WorkspaceMigrationActionRunnerContext<FlatCreateIndexAction>,
  ): Promise<void> {
    const {
      allFlatEntityMaps: { flatObjectMetadataMaps, flatFieldMetadataMaps },
      flatAction: { flatEntity: flatIndexMetadata },
      queryRunner,
      workspaceId,
    } = context;

    if (this.shouldDeferIndexCreation(context)) {
      return;
    }

    const flatObjectMetadata = findFlatEntityByIdInFlatEntityMapsOrThrow({
      flatEntityMaps: flatObjectMetadataMaps,
      flatEntityId: flatIndexMetadata.objectMetadataId,
    });

    await createIndexInWorkspaceSchema({
      flatIndexMetadata,
      flatFieldMetadataMaps,
      flatObjectMetadata,
      workspaceSchemaManagerService: this.workspaceSchemaManagerService,
      queryRunner,
      workspaceId,
    });
  }

  override async executeForWorkspaceSchemaBatch(
    contexts: WorkspaceMigrationActionRunnerContext<FlatCreateIndexAction>[],
  ): Promise<void> {
    if (contexts.length === 0) {
      return;
    }

    const indexes = contexts
      .filter((context) => !this.shouldDeferIndexCreation(context))
      .map((context) => {
        const {
          allFlatEntityMaps: { flatObjectMetadataMaps, flatFieldMetadataMaps },
          flatAction: { flatEntity: flatIndexMetadata },
          workspaceId,
        } = context;

        const flatObjectMetadata = findFlatEntityByIdInFlatEntityMapsOrThrow({
          flatEntityMaps: flatObjectMetadataMaps,
          flatEntityId: flatIndexMetadata.objectMetadataId,
        });

        const { schemaName, tableName } = getWorkspaceSchemaContextForMigration(
          {
            workspaceId,
            objectMetadata: flatObjectMetadata,
          },
        );

        const columns = computeFlatIndexFieldColumnNames({
          flatIndexFieldMetadatas: flatIndexMetadata.flatIndexFieldMetadatas,
          flatFieldMetadataMaps,
        });

        return {
          schemaName,
          tableName,
          index: {
            columns,
            name: flatIndexMetadata.name,
            isUnique: flatIndexMetadata.isUnique,
            type: flatIndexMetadata.indexType,
            where: flatIndexMetadata.indexWhereClause ?? undefined,
          },
        };
      });

    await this.workspaceSchemaManagerService.indexManager.createIndexes({
      queryRunner: contexts[0].queryRunner,
      indexes,
    });
  }

  protected override getDeferredAction(
    context: WorkspaceMigrationActionRunnerContext<FlatCreateIndexAction>,
  ) {
    if (!this.shouldDeferIndexCreation(context)) {
      return undefined;
    }

    return {
      name: 'build_index' as const,
      payload: { indexMetadataId: context.flatAction.flatEntity.id },
    };
  }

  private shouldDeferIndexCreation({
    featureFlagsMap,
    allFlatEntityMaps: { flatFieldMetadataMaps },
    flatAction: { flatEntity: flatIndexMetadata },
  }: WorkspaceMigrationActionRunnerContext<FlatCreateIndexAction>): boolean {
    if (
      !featureFlagsMap?.[
        FeatureFlagKey.IS_DEFERRED_WORKSPACE_MIGRATION_ACTIONS_ENABLED
      ]
    ) {
      return false;
    }

    return isIndexCreationDeferrable({
      flatIndexMetadata,
      indexedFlatFieldMetadatas: findManyFlatEntityByIdInFlatEntityMaps({
        flatEntityMaps: flatFieldMetadataMaps,
        flatEntityIds: flatIndexMetadata.flatIndexFieldMetadatas.map(
          (flatIndexFieldMetadata) => flatIndexFieldMetadata.fieldMetadataId,
        ),
      }),
    });
  }
}
