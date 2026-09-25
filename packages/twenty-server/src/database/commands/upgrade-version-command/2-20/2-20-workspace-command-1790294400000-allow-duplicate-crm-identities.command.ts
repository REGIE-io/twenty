import { InjectDataSource } from '@nestjs/typeorm';
import { Command } from 'nest-commander';
import { STANDARD_OBJECTS } from 'twenty-shared/metadata';
import { isDefined } from 'twenty-shared/utils';
import { DataSource } from 'typeorm';

import { ProvisionedWorkspaceCommandRunner } from 'src/database/commands/command-runners/provisioned-workspace.command-runner';
import { WorkspaceIteratorService } from 'src/database/commands/command-runners/workspace-iterator.service';
import { type RunOnWorkspaceArgs } from 'src/database/commands/command-runners/workspace.command-runner';
import { RegisteredWorkspaceCommand } from 'src/engine/core-modules/upgrade/decorators/registered-workspace-command.decorator';
import { FieldMetadataEntity } from 'src/engine/metadata-modules/field-metadata/field-metadata.entity';
import { IndexMetadataEntity } from 'src/engine/metadata-modules/index-metadata/index-metadata.entity';
import { WorkspaceMetadataVersionService } from 'src/engine/metadata-modules/workspace-metadata-version/services/workspace-metadata-version.service';
import { WorkspaceSchemaManagerService } from 'src/engine/twenty-orm/workspace-schema-manager/workspace-schema-manager.service';
import { WorkspaceCacheService } from 'src/engine/workspace-cache/services/workspace-cache.service';
import { getWorkspaceSchemaName } from 'src/engine/workspace-datasource/utils/get-workspace-schema-name.util';
import { createIndexInWorkspaceSchema, dropIndexFromWorkspaceSchema } from 'src/engine/workspace-manager/workspace-migration/workspace-migration-runner/action-handlers/index/utils/index-action-handler.utils';

@RegisteredWorkspaceCommand('2.20.0', 1790294400000)
@Command({
  name: 'upgrade:2-20:allow-duplicate-crm-identities',
  description: 'Replace standard person email and company domain unique indexes with lookup indexes',
})
export class AllowDuplicateCrmIdentitiesCommand extends ProvisionedWorkspaceCommandRunner {
  constructor(
    protected readonly workspaceIteratorService: WorkspaceIteratorService,
    private readonly workspaceCacheService: WorkspaceCacheService,
    private readonly workspaceSchemaManagerService: WorkspaceSchemaManagerService,
    private readonly workspaceMetadataVersionService: WorkspaceMetadataVersionService,
    @InjectDataSource() private readonly dataSource: DataSource,
  ) {
    super(workspaceIteratorService);
  }

  override async runOnWorkspace({ workspaceId, options }: RunOnWorkspaceArgs): Promise<void> {
    const { flatFieldMetadataMaps, flatObjectMetadataMaps, flatIndexMaps } =
      await this.workspaceCacheService.getOrRecompute(workspaceId, [
        'flatFieldMetadataMaps', 'flatObjectMetadataMaps', 'flatIndexMaps',
      ]);
    const targets = [
      STANDARD_OBJECTS.person.fields.emails.universalIdentifier,
      STANDARD_OBJECTS.company.fields.domainName.universalIdentifier,
    ].map((universalIdentifier) => {
      const field = flatFieldMetadataMaps.byUniversalIdentifier[universalIdentifier];
      if (!isDefined(field) || field.isCustom) {
        throw new Error(`Missing standard CRM identity field ${universalIdentifier} in ${workspaceId}`);
      }
      const object = flatObjectMetadataMaps.byUniversalIdentifier[field.objectMetadataUniversalIdentifier];
      const indexes = Object.values(flatIndexMaps.byUniversalIdentifier).filter(isDefined).filter((index) =>
        !index.isCustom && index.objectMetadataId === field.objectMetadataId &&
        index.flatIndexFieldMetadatas.length === 1 &&
        index.flatIndexFieldMetadatas[0].fieldMetadataId === field.id,
      );
      if (!isDefined(object) || indexes.length !== 1) {
        throw new Error(`Expected one standard lookup index for ${field.name} in ${workspaceId}`);
      }
      return { field, object, index: indexes[0] };
    });
    const queryRunner = this.dataSource.createQueryRunner();
    const schemaName = getWorkspaceSchemaName(workspaceId);
    await queryRunner.connect();
    try {
      if (!options.dryRun) {
        await queryRunner.startTransaction();
        await queryRunner.query("SET LOCAL lock_timeout = '5s'");
      }
      for (const { field, object, index } of targets) {
        const physical: { isUnique: boolean; isValid: boolean }[] = await queryRunner.query(
          `SELECT i.indisunique AS "isUnique", i.indisvalid AS "isValid"
           FROM pg_index i JOIN pg_class c ON c.oid = i.indexrelid
           JOIN pg_namespace n ON n.oid = c.relnamespace
           WHERE n.nspname = $1 AND c.relname = $2`, [schemaName, index.name],
        );
        const needsRebuild = physical.length === 0 || physical[0].isUnique || !physical[0].isValid;
        this.logger.log(`${options.dryRun ? '[DRY RUN] ' : ''}${workspaceId} ${object.nameSingular}.${field.name}: rebuild=${needsRebuild}, fieldUnique=${field.isUnique}, indexUnique=${index.isUnique}`);
        if (options.dryRun) continue;
        if (needsRebuild) {
          if (physical.length > 0) {
            await dropIndexFromWorkspaceSchema({ indexName: index.name, workspaceSchemaManagerService: this.workspaceSchemaManagerService, queryRunner, schemaName });
          }
          await createIndexInWorkspaceSchema({ flatIndexMetadata: { ...index, isUnique: false }, flatObjectMetadata: object, flatFieldMetadataMaps, workspaceSchemaManagerService: this.workspaceSchemaManagerService, queryRunner, workspaceId });
        }
        // One transaction preserves the index identity without the field side effect deleting it.
        await queryRunner.manager.getRepository(IndexMetadataEntity).update({ id: index.id, workspaceId }, { isUnique: false });
        await queryRunner.manager.getRepository(FieldMetadataEntity).update({ id: field.id, workspaceId }, { isUnique: false });
      }
      if (!options.dryRun) await queryRunner.commitTransaction();
    } catch (error) {
      if (queryRunner.isTransactionActive) await queryRunner.rollbackTransaction();
      throw error;
    } finally {
      await queryRunner.release();
    }
    if (!options.dryRun) {
      await this.workspaceCacheService.flush(workspaceId, ['flatFieldMetadataMaps', 'flatObjectMetadataMaps', 'flatIndexMaps']);
      await this.workspaceMetadataVersionService.incrementMetadataVersion(workspaceId);
    }
  }
}
