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
import { InjectMessageQueue } from 'src/engine/core-modules/message-queue/decorators/message-queue.decorator';
import { MessageQueue } from 'src/engine/core-modules/message-queue/message-queue.constants';
import { MessageQueueService } from 'src/engine/core-modules/message-queue/services/message-queue.service';
import { PhoneSearchIndexJob } from 'src/engine/core-modules/phone-search-index/jobs/phone-search-index.job';
import { type FlatFieldMetadata } from 'src/engine/metadata-modules/flat-field-metadata/types/flat-field-metadata.type';
import { WorkspaceCacheService } from 'src/engine/workspace-cache/services/workspace-cache.service';
import { getWorkspaceSchemaName } from 'src/engine/workspace-datasource/utils/get-workspace-schema-name.util';

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
    @InjectMessageQueue(MessageQueue.phoneSearchIndexQueue)
    private readonly queue: MessageQueueService,
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
    const schema = getWorkspaceSchemaName(workspaceId);
    let operationId: string | undefined;
    try {
      await runner.connect();
      await runner.startTransaction();
      await runner.query("SET LOCAL lock_timeout = '2s'");
      await runner.query(
        `DROP TRIGGER IF EXISTS "TRG_PERSON_PHONE_LOOKUP_SYNC" ON "${schema}"."person"`,
      );
      await runner.query(
        `CREATE TRIGGER "TRG_PERSON_PHONE_LOOKUP_SYNC" AFTER INSERT OR UPDATE OR DELETE ON "${schema}"."person" FOR EACH ROW EXECUTE FUNCTION public.sync_person_phone_lookup('${workspaceId}', '${person.id}')`,
      );
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
        await this.queue.add(PhoneSearchIndexJob.name, { operationId });
    } catch (error) {
      if (runner.isTransactionActive) await runner.rollbackTransaction();
      throw error;
    } finally {
      await runner.release();
    }
  }
}
