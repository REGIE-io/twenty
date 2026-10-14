import { Command, Option } from 'nest-commander';
import { isDefined } from 'twenty-shared/utils';

import {
  ProvisionedWorkspaceCommandRunner,
  type ProvisionedWorkspaceCommandOptions,
} from 'src/database/commands/command-runners/provisioned-workspace.command-runner';
import { WorkspaceIteratorService } from 'src/database/commands/command-runners/workspace-iterator.service';
import { type RunOnWorkspaceArgs } from 'src/database/commands/command-runners/workspace.command-runner';
import { SearchVectorTriggerConversionService } from 'src/engine/core-modules/search-vector-trigger/services/search-vector-trigger-conversion.service';

type ConvertSearchVectorToTriggerCommandOptions =
  ProvisionedWorkspaceCommandOptions & {
    repair?: boolean;
    allWorkspaces?: boolean;
  };

@Command({
  name: 'workspace:convert-search-vector-to-trigger',
  description:
    'Convert generated searchVector columns to trigger-maintained columns',
})
export class ConvertSearchVectorToTriggerCommand extends ProvisionedWorkspaceCommandRunner<ConvertSearchVectorToTriggerCommandOptions> {
  constructor(
    protected readonly workspaceIteratorService: WorkspaceIteratorService,
    private readonly searchVectorTriggerConversionService: SearchVectorTriggerConversionService,
  ) {
    super(workspaceIteratorService);
  }

  // Opt-in because a repair rewrites every row of the broken tables through a backfill.
  @Option({
    flags: '--repair',
    description:
      'Also convert tables whose stored searchVector differs from the formula or whose column is missing, backfill them, and rebuild a broken searchVector index concurrently',
    required: false,
  })
  parseRepair(): boolean {
    return true;
  }

  @Option({
    flags: '--all-workspaces',
    description: 'Run on every workspace instead of the ones passed with -w',
    required: false,
  })
  parseAllWorkspaces(): boolean {
    return true;
  }

  // A missing -w must not sweep the whole fleet; that takes an explicit --all-workspaces.
  override async run(
    passedParams: string[],
    options: ConvertSearchVectorToTriggerCommandOptions,
  ): Promise<void> {
    const hasWorkspaceIds =
      isDefined(options.workspaceId) && options.workspaceId.size > 0;

    if (hasWorkspaceIds && options.allWorkspaces === true) {
      throw new Error('Pass either -w or --all-workspaces, not both.');
    }

    if (!hasWorkspaceIds && options.allWorkspaces !== true) {
      throw new Error(
        'Pass at least one workspace with -w, or --all-workspaces.',
      );
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
    const repair =
      (options as ConvertSearchVectorToTriggerCommandOptions).repair ?? false;

    const report =
      await this.searchVectorTriggerConversionService.convertWorkspace({
        workspaceId,
        dryRun,
        repair,
      });

    this.logger.log(
      `${dryRun ? '[DRY RUN] ' : ''}Workspace ${workspaceId} (${index + 1}/${total}): ${report.status}`,
    );

    for (const table of report.tables) {
      this.logger.log(
        `  ${table.tableName}: ${table.status}, mismatchCount=${table.mismatchCount}${isDefined(table.indexHealth) ? `, index=${table.indexHealth}` : ''}${isDefined(table.error) ? `, error=${table.error}` : ''}${isDefined(table.note) ? `, note=${table.note}` : ''}`,
      );
    }
  }
}
