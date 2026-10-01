import { InjectDataSource } from '@nestjs/typeorm';
import { Command } from 'nest-commander';
import { isDefined } from 'twenty-shared/utils';
import { DataSource } from 'typeorm';

import { ProvisionedWorkspaceCommandRunner } from 'src/database/commands/command-runners/provisioned-workspace.command-runner';
import { WorkspaceIteratorService } from 'src/database/commands/command-runners/workspace-iterator.service';
import { type RunOnWorkspaceArgs } from 'src/database/commands/command-runners/workspace.command-runner';
import { RegisteredWorkspaceCommand } from 'src/engine/core-modules/upgrade/decorators/registered-workspace-command.decorator';
import { WorkspaceCacheService } from 'src/engine/workspace-cache/services/workspace-cache.service';
import {
  ensureParticipantHandleIndex,
  PARTICIPANT_HANDLE_INDEXES,
} from 'src/engine/workspace-manager/workspace-migration/workspace-migration-runner/action-handlers/object/utils/ensure-participant-handle-index.util';

@RegisteredWorkspaceCommand('2.32.0', 1790812800000)
@Command({
  name: 'upgrade:2-32:add-participant-handle-indexes',
  description: 'Index normalized participant addresses for shared-address timelines',
})
export class AddParticipantHandleIndexesCommand extends ProvisionedWorkspaceCommandRunner {
  constructor(
    protected readonly workspaceIteratorService: WorkspaceIteratorService,
    private readonly workspaceCacheService: WorkspaceCacheService,
    @InjectDataSource() private readonly dataSource: DataSource,
  ) {
    super(workspaceIteratorService);
  }

  override async runOnWorkspace({ workspaceId, options }: RunOnWorkspaceArgs): Promise<void> {
    const { flatObjectMetadataMaps } = await this.workspaceCacheService.getOrRecompute(
      workspaceId,
      ['flatObjectMetadataMaps'],
    );
    const objects = PARTICIPANT_HANDLE_INDEXES.map(
      ({ universalIdentifier }) => flatObjectMetadataMaps.byUniversalIdentifier[universalIdentifier],
    ).filter(isDefined);

    if (objects.length === 0) {
      return;
    }

    const queryRunner = this.dataSource.createQueryRunner();

    await queryRunner.connect();
    try {
      await queryRunner.startTransaction();
      await queryRunner.query("SET LOCAL lock_timeout = '5s'");
      for (const objectMetadata of objects) {
        await ensureParticipantHandleIndex({
          queryRunner,
          workspaceId,
          objectMetadata,
          dryRun: options.dryRun,
        });
        this.logger.log(
          `${options.dryRun ? '[DRY RUN] ' : ''}${workspaceId} ${objectMetadata.nameSingular}: normalized handle index checked`,
        );
      }
      await queryRunner.commitTransaction();
    } catch (error) {
      if (queryRunner.isTransactionActive) {
        await queryRunner.rollbackTransaction();
      }
      throw error;
    } finally {
      await queryRunner.release();
    }
  }
}
