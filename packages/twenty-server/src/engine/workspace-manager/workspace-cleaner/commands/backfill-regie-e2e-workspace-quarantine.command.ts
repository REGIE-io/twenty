import { Logger } from '@nestjs/common';

import { Command, CommandRunner, Option } from 'nest-commander';

import { RegieE2eWorkspaceQuarantineBackfillWorkspaceService } from 'src/engine/workspace-manager/workspace-cleaner/services/regie-e2e-workspace-quarantine-backfill.workspace-service';

type BackfillRegieE2eWorkspaceQuarantineOptions = {
  all?: boolean;
  apply?: boolean;
  organizationIds?: string[];
};

@Command({
  name: 'workspace:backfill-regie-e2e-quarantine',
  description:
    'Dry-run or apply the one-time quarantine backfill for persistently marked Regie E2E workspaces',
})
export class BackfillRegieE2eWorkspaceQuarantineCommand extends CommandRunner {
  private readonly logger = new Logger(
    BackfillRegieE2eWorkspaceQuarantineCommand.name,
  );

  constructor(
    private readonly backfill: RegieE2eWorkspaceQuarantineBackfillWorkspaceService,
  ) {
    super();
  }

  @Option({
    flags: '--organization-ids <organizationIds>',
    description:
      'Comma-separated exact org_e2e_ organization IDs for a limited run',
  })
  parseOrganizationIds(value: string): string[] {
    return value.split(',').map((id) => id.trim());
  }

  @Option({
    flags: '--all',
    description: 'Select every persistently marked safe Regie E2E workspace',
  })
  parseAll(): boolean {
    return true;
  }

  @Option({
    flags: '--apply',
    description: 'Apply the quarantine; omission is always a dry run',
  })
  parseApply(): boolean {
    return true;
  }

  async run(
    _passedParams: string[],
    options: BackfillRegieE2eWorkspaceQuarantineOptions,
  ): Promise<void> {
    if (!options.all && options.organizationIds === undefined) {
      throw new Error('Choose --organization-ids for a limited run or --all');
    }

    const result = await this.backfill.run({
      mode: options.all ? 'all' : 'limited',
      apply: options.apply === true,
      organizationIds: options.organizationIds,
    });

    this.logger.log(JSON.stringify(result));
  }
}
