import { InjectDataSource } from '@nestjs/typeorm';
import { Command } from 'nest-commander';
import { STANDARD_OBJECTS } from 'twenty-shared/metadata';
import { isDefined } from 'twenty-shared/utils';
import { DataSource } from 'typeorm';

import { ProvisionedWorkspaceCommandRunner } from 'src/database/commands/command-runners/provisioned-workspace.command-runner';
import { WorkspaceIteratorService } from 'src/database/commands/command-runners/workspace-iterator.service';
import { type RunOnWorkspaceArgs } from 'src/database/commands/command-runners/workspace.command-runner';
import { ApplicationService } from 'src/engine/core-modules/application/application.service';
import { RegisteredWorkspaceCommand } from 'src/engine/core-modules/upgrade/decorators/registered-workspace-command.decorator';
import { WorkspaceSchemaManagerService } from 'src/engine/twenty-orm/workspace-schema-manager/workspace-schema-manager.service';
import { WorkspaceCacheService } from 'src/engine/workspace-cache/services/workspace-cache.service';
import { getWorkspaceSchemaName } from 'src/engine/workspace-datasource/utils/get-workspace-schema-name.util';
import { computeTwentyStandardApplicationAllFlatEntityMaps } from 'src/engine/workspace-manager/twenty-standard-application/utils/twenty-standard-application-all-flat-entity-maps.constant';
import { WorkspaceMigrationValidateBuildAndRunService } from 'src/engine/workspace-manager/workspace-migration/services/workspace-migration-validate-build-and-run-service';
import { escapeIdentifier } from 'src/engine/workspace-manager/workspace-migration/utils/remove-sql-injection.util';
import { createIndexInWorkspaceSchema } from 'src/engine/workspace-manager/workspace-migration/workspace-migration-runner/action-handlers/index/utils/index-action-handler.utils';

const INDEX_UNIVERSAL_IDENTIFIER =
  STANDARD_OBJECTS.person.indexes.emailsAdditionalEmailsGinIndex
    .universalIdentifier;

// Person tables are large, so the GIN index is built concurrently before its
// metadata is persisted; the migration's CREATE INDEX IF NOT EXISTS is then a no-op.
@RegisteredWorkspaceCommand('2.32.0', 1791417600000)
@Command({
  name: 'upgrade:2-32:add-person-additional-emails-gin-index',
  description:
    'Create the standard GIN index on person additional emails for participant matching',
})
export class AddPersonAdditionalEmailsGinIndexCommand extends ProvisionedWorkspaceCommandRunner {
  constructor(
    protected readonly workspaceIteratorService: WorkspaceIteratorService,
    private readonly applicationService: ApplicationService,
    private readonly workspaceCacheService: WorkspaceCacheService,
    private readonly workspaceSchemaManagerService: WorkspaceSchemaManagerService,
    private readonly workspaceMigrationValidateBuildAndRunService: WorkspaceMigrationValidateBuildAndRunService,
    @InjectDataSource() private readonly dataSource: DataSource,
  ) {
    super(workspaceIteratorService);
  }

  override async runOnWorkspace({
    workspaceId,
    options,
  }: RunOnWorkspaceArgs): Promise<void> {
    const { flatObjectMetadataMaps, flatIndexMaps } =
      await this.workspaceCacheService.getOrRecompute(workspaceId, [
        'flatObjectMetadataMaps',
        'flatIndexMaps',
      ]);
    const personObjectMetadata =
      flatObjectMetadataMaps.byUniversalIdentifier[
        STANDARD_OBJECTS.person.universalIdentifier
      ];

    if (
      !isDefined(personObjectMetadata) ||
      isDefined(flatIndexMaps.byUniversalIdentifier[INDEX_UNIVERSAL_IDENTIFIER])
    ) {
      return;
    }

    const { twentyStandardFlatApplication } =
      await this.applicationService.findWorkspaceTwentyStandardAndCustomApplicationOrThrow(
        { workspaceId },
      );
    const { allFlatEntityMaps: standardFlatEntityMaps } =
      computeTwentyStandardApplicationAllFlatEntityMaps({
        now: new Date().toISOString(),
        workspaceId,
        twentyStandardApplicationId: twentyStandardFlatApplication.id,
      });
    const standardIndex =
      standardFlatEntityMaps.flatIndexMaps.byUniversalIdentifier[
        INDEX_UNIVERSAL_IDENTIFIER
      ];

    if (!isDefined(standardIndex)) {
      throw new Error(
        `Missing standard person additional emails GIN index for ${workspaceId}`,
      );
    }

    this.logger.log(
      `${options.dryRun ? '[DRY RUN] ' : ''}${workspaceId} person: creating ${standardIndex.name}`,
    );

    if (options.dryRun) {
      return;
    }

    const schemaName = getWorkspaceSchemaName(workspaceId);
    const queryRunner = this.dataSource.createQueryRunner();

    await queryRunner.connect();
    try {
      const existing: { isValid: boolean }[] = await queryRunner.query(
        `SELECT i.indisvalid AS "isValid" FROM pg_index i
         JOIN pg_class c ON c.oid = i.indexrelid
         JOIN pg_namespace n ON n.oid = c.relnamespace
         WHERE n.nspname = $1 AND c.relname = $2`,
        [schemaName, standardIndex.name],
      );

      // An interrupted concurrent build leaves an invalid index that IF NOT EXISTS would keep.
      if (existing.length > 0 && !existing[0].isValid) {
        await queryRunner.query(
          `DROP INDEX CONCURRENTLY IF EXISTS ${escapeIdentifier(schemaName)}.${escapeIdentifier(standardIndex.name)}`,
        );
      }

      await createIndexInWorkspaceSchema({
        flatIndexMetadata: standardIndex,
        flatObjectMetadata: personObjectMetadata,
        flatFieldMetadataMaps: standardFlatEntityMaps.flatFieldMetadataMaps,
        workspaceSchemaManagerService: this.workspaceSchemaManagerService,
        queryRunner,
        workspaceId,
        concurrently: true,
      });
    } finally {
      await queryRunner.release();
    }

    const result =
      await this.workspaceMigrationValidateBuildAndRunService.validateBuildAndRunWorkspaceMigration(
        {
          isSystemBuild: true,
          workspaceId,
          applicationUniversalIdentifier:
            twentyStandardFlatApplication.universalIdentifier,
          allFlatEntityOperationByMetadataName: {
            index: {
              flatEntityToCreate: [standardIndex],
              flatEntityToDelete: [],
              flatEntityToUpdate: [],
            },
          },
        },
      );

    if (result.status === 'fail') {
      throw new Error(
        `Failed to persist person additional emails GIN index metadata for ${workspaceId}: ${JSON.stringify(result)}`,
      );
    }
  }
}
