import { Command } from 'nest-commander';
import { isDefined } from 'twenty-shared/utils';

import { ProvisionedWorkspaceCommandRunner } from 'src/database/commands/command-runners/provisioned-workspace.command-runner';
import { WorkspaceIteratorService } from 'src/database/commands/command-runners/workspace-iterator.service';
import {
  type RunOnWorkspaceArgs,
  type WorkspaceCommandOptions,
} from 'src/database/commands/command-runners/workspace.command-runner';
import { SearchVectorTriggerConversionService } from 'src/engine/core-modules/search-vector-trigger/services/search-vector-trigger-conversion.service';

// Until the migration runner writes trigger mode, a converted table would be reverted to a
// generated column by the next search field change.
const IS_REAL_CONVERSION_ENABLED = false;

@Command({
  name: 'workspace:convert-search-vector-to-trigger',
  description:
    'Convert generated searchVector columns to trigger-maintained columns',
})
export class ConvertSearchVectorToTriggerCommand extends ProvisionedWorkspaceCommandRunner {
  constructor(
    protected readonly workspaceIteratorService: WorkspaceIteratorService,
    private readonly searchVectorTriggerConversionService: SearchVectorTriggerConversionService,
  ) {
    super(workspaceIteratorService);
  }

  // Rollout is per workspace on purpose; a missing -w must not sweep the whole fleet.
  override async run(
    passedParams: string[],
    options: WorkspaceCommandOptions,
  ): Promise<void> {
    if (!isDefined(options.workspaceId) || options.workspaceId.size === 0) {
      throw new Error('Pass at least one workspace with -w.');
    }

    await super.run(passedParams, options);
  }

  override async runOnWorkspace({
    workspaceId,
    options,
    index,
    total,
  }: RunOnWorkspaceArgs): Promise<void> {
    const dryRun = options.dryRun ?? false;

    if (!dryRun && !IS_REAL_CONVERSION_ENABLED) {
      this.logger.warn(
        'Real conversion is disabled until trigger mode lands in the migration runner. Use --dry-run.',
      );

      return;
    }

    const report =
      await this.searchVectorTriggerConversionService.convertWorkspace({
        workspaceId,
        dryRun,
      });

    this.logger.log(
      `${dryRun ? '[DRY RUN] ' : ''}Workspace ${workspaceId} (${index + 1}/${total}): ${report.status}`,
    );

    for (const table of report.tables) {
      this.logger.log(
        `  ${table.tableName}: ${table.status}, mismatchCount=${table.mismatchCount}${isDefined(table.error) ? `, error=${table.error}` : ''}`,
      );
    }
  }
}
