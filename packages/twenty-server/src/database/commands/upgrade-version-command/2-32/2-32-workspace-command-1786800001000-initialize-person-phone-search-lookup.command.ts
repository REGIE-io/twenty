import { InjectDataSource } from '@nestjs/typeorm';
import { Command } from 'nest-commander';
import { STANDARD_OBJECTS } from 'twenty-shared/metadata';
import { FieldMetadataType } from 'twenty-shared/types';
import { isDefined } from 'twenty-shared/utils';
import { DataSource } from 'typeorm';

import { ProvisionedWorkspaceCommandRunner } from 'src/database/commands/command-runners/provisioned-workspace.command-runner';
import { WorkspaceIteratorService } from 'src/database/commands/command-runners/workspace-iterator.service';
import { type RunOnWorkspaceArgs } from 'src/database/commands/command-runners/workspace.command-runner';
import { RegisteredWorkspaceCommand } from 'src/engine/core-modules/upgrade/decorators/registered-workspace-command.decorator';
import { PhoneSearchFieldLifecycleCoordinatorService } from 'src/engine/core-modules/phone-search-index/services/phone-search-field-lifecycle-coordinator.service';
import { PhoneSearchTriggerManagerService } from 'src/engine/core-modules/phone-search-index/services/phone-search-trigger-manager.service';
import { type FlatFieldMetadata } from 'src/engine/metadata-modules/flat-field-metadata/types/flat-field-metadata.type';
import { WorkspaceCacheService } from 'src/engine/workspace-cache/services/workspace-cache.service';

@RegisteredWorkspaceCommand('2.32.0', 1786800001000)
@Command({
  name: 'upgrade:2-32:initialize-person-phone-search-lookup',
  description:
    'Install the stable Person phone lookup trigger and queue an online backfill.',
})
export class InitializePersonPhoneSearchLookupCommand extends ProvisionedWorkspaceCommandRunner {
  constructor(
    protected readonly workspaceIteratorService: WorkspaceIteratorService,
    private readonly workspaceCacheService: WorkspaceCacheService,
    @InjectDataSource() private readonly dataSource: DataSource,
    private readonly triggerManager: PhoneSearchTriggerManagerService,
    private readonly lifecycleCoordinator: PhoneSearchFieldLifecycleCoordinatorService,
  ) {
    super(workspaceIteratorService);
  }

  override async runOnWorkspace({
    workspaceId,
    options,
  }: RunOnWorkspaceArgs): Promise<void> {
    if (options.dryRun) return;
    const { flatObjectMetadataMaps, flatFieldMetadataMaps } =
      await this.workspaceCacheService.getOrRecompute(workspaceId, [
        'flatObjectMetadataMaps',
        'flatFieldMetadataMaps',
      ]);
    const person =
      flatObjectMetadataMaps.byUniversalIdentifier[
        STANDARD_OBJECTS.person.universalIdentifier
      ];
    if (!isDefined(person)) return;
    const fields = Object.values(
      flatFieldMetadataMaps.byUniversalIdentifier,
    ).filter(
      (field): field is FlatFieldMetadata =>
        isDefined(field) &&
        field.objectMetadataUniversalIdentifier ===
          person.universalIdentifier &&
        field.type === FieldMetadataType.PHONES,
    );
    if (!fields.length) return;
    const runner = this.dataSource.createQueryRunner();
    let operationId: string | undefined;
    try {
      await this.triggerManager.install({
        workspaceId,
        objectMetadataId: person.id,
      });
      await runner.connect();
      await runner.startTransaction();
      await runner.query("SET LOCAL lock_timeout = '2s'");
      const existing = (await runner.query(
        `SELECT id FROM core."phoneSearchIndexOperation" WHERE "workspaceId" = $1 AND "objectMetadataId" = $2 AND status IN ('PENDING','RUNNING','RETRYABLE')`,
        [workspaceId, person.id],
      )) as Array<{ id: string }>;
      if (!existing.length) {
        for (const field of fields) {
          await runner.query(
            `INSERT INTO core."phoneSearchFieldState" ("workspaceId", "objectMetadataId", "fieldMetadataId", "fieldUniversalIdentifier", "physicalFieldName", "syncStatus", "isQueryEnabled", "buildingProjectionGeneration") VALUES ($1, $2, $3, $4, $5, 'INDEXING', $6, 1) ON CONFLICT ("workspaceId", "objectMetadataId", "fieldMetadataId") DO NOTHING`,
            [
              workspaceId,
              person.id,
              field.id,
              field.universalIdentifier,
              field.name,
              field.isActive,
            ],
          );
        }
        const [operation] = (await runner.query(
          `INSERT INTO core."phoneSearchIndexOperation" ("workspaceId", "objectMetadataId", kind, status, generation, "fieldMetadataIds") VALUES ($1, $2, 'INITIALIZE', 'PENDING', 1, $3::jsonb) RETURNING id`,
          [
            workspaceId,
            person.id,
            JSON.stringify(fields.map((field) => field.id)),
          ],
        )) as Array<{ id: string }>;
        operationId = operation?.id;
      }
      await runner.commitTransaction();
      if (operationId)
        await this.lifecycleCoordinator.enqueue([operationId]);
    } catch (error) {
      if (runner.isTransactionActive) await runner.rollbackTransaction();
      throw error;
    } finally {
      await runner.release();
    }
  }
}
