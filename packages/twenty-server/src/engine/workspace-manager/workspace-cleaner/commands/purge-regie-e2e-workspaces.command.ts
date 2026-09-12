import { Logger } from '@nestjs/common';

import { Command, CommandRunner } from 'nest-commander';

import { RegieE2eWorkspaceSweeperService } from 'src/engine/workspace-manager/workspace-cleaner/services/regie-e2e-workspace-sweeper.service';

@Command({
  name: 'workspace:purge-regie-e2e-batch',
  description:
    'Permanently delete one guarded batch of eligible Regie E2E workspaces',
})
export class PurgeRegieE2eWorkspacesCommand extends CommandRunner {
  private readonly logger = new Logger(PurgeRegieE2eWorkspacesCommand.name);

  constructor(
    private readonly regieE2eWorkspaceSweeperService: RegieE2eWorkspaceSweeperService,
  ) {
    super();
  }

  async run(): Promise<void> {
    const deletedCount =
      await this.regieE2eWorkspaceSweeperService.purgeQuarantinedWorkspaces();

    this.logger.log(
      `Purged ${deletedCount} eligible Regie E2E workspaces in this batch`,
    );
  }
}
