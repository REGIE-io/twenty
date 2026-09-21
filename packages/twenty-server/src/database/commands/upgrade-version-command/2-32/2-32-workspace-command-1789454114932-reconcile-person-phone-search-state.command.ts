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

@RegisteredWorkspaceCommand('2.32.0', 1789454114932)
@Command({
  name: 'upgrade:2-32:reconcile-person-phone-search-state',
  description:
    'Create durable phone-search state omitted by legacy fresh-workspace provisioning.',
})
export class ReconcilePersonPhoneSearchStateCommand extends ProvisionedWorkspaceCommandRunner {
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

    const phoneFields = Object.values(
      flatFieldMetadataMaps.byUniversalIdentifier,
    ).filter(
      (field): field is FlatFieldMetadata =>
        isDefined(field) &&
        field.objectMetadataUniversalIdentifier ===
          person.universalIdentifier &&
        field.type === FieldMetadataType.PHONES,
    );

    if (phoneFields.length === 0) return;

    const existingStates = await this.dataSource.query<
      Array<{ fieldMetadataId: string }>
    >(
      `SELECT "fieldMetadataId"
         FROM core."phoneSearchFieldState"
        WHERE "workspaceId" = $1
          AND "objectMetadataId" = $2
          AND "fieldMetadataId" = ANY($3::uuid[])`,
      [workspaceId, person.id, phoneFields.map((field) => field.id)],
    );
    const existingFieldIds = new Set(
      existingStates.map(({ fieldMetadataId }) => fieldMetadataId),
    );
    const missingFields = phoneFields.filter(
      (field) => !existingFieldIds.has(field.id),
    );

    if (missingFields.length === 0) return;

    await this.triggerManager.install({
      workspaceId,
      objectMetadataId: person.id,
    });
    await this.lifecycleCoordinator.afterMigration({
      workspaceId,
      objectMetadataId: person.id,
      created: missingFields,
      updated: [],
      deleted: [],
    });
  }
}
