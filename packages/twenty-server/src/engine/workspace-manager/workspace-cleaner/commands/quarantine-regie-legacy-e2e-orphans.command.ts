import { Logger } from '@nestjs/common';

import { Command, CommandRunner, Option } from 'nest-commander';

import { RegieLegacyE2eOrphanQuarantineBackfillWorkspaceService } from 'src/engine/workspace-manager/workspace-cleaner/services/regie-legacy-e2e-orphan-quarantine-backfill.workspace-service';

type Options = {
  apply?: boolean;
  createdBefore?: string;
  maxCandidates?: number;
  expectedCount?: number;
  expectedSha256?: string;
};

@Command({
  name: 'workspace:quarantine-regie-legacy-e2e-orphans',
  description:
    'Dry-run or quarantine and authorize a reviewed batch of active legacy Regie E2E orphans',
})
export class QuarantineRegieLegacyE2eOrphansCommand extends CommandRunner {
  private readonly logger = new Logger(
    QuarantineRegieLegacyE2eOrphansCommand.name,
  );

  constructor(
    private readonly backfill: RegieLegacyE2eOrphanQuarantineBackfillWorkspaceService,
  ) {
    super();
  }

  @Option({
    flags: '--created-before <createdBefore>',
    description: 'Required ISO timestamp bounding the reviewed legacy cohort',
  })
  parseCreatedBefore(value: string): string {
    return value;
  }

  @Option({
    flags: '--max-candidates <maxCandidates>',
    description: 'Maximum reviewed candidates in this restartable batch',
    defaultValue: 100,
  })
  parseMaxCandidates(value: string): number {
    return Number(value);
  }

  @Option({
    flags: '--expected-count <expectedCount>',
    description: 'Required in apply mode; exact count emitted by the dry run',
  })
  parseExpectedCount(value: string): number {
    return Number(value);
  }

  @Option({
    flags: '--expected-sha256 <expectedSha256>',
    description:
      'Required in apply mode; exact fingerprint emitted by the dry run',
  })
  parseExpectedSha256(value: string): string {
    return value;
  }

  @Option({
    flags: '--apply',
    description: 'Quarantine and mark the reviewed batch',
  })
  parseApply(): boolean {
    return true;
  }

  async run(_passedParams: string[], options: Options): Promise<void> {
    if (!options.createdBefore) {
      throw new Error('--created-before is required');
    }

    const result = await this.backfill.run({
      apply: options.apply === true,
      createdBefore: options.createdBefore,
      maxCandidates: options.maxCandidates ?? 100,
      expectedCount: options.expectedCount,
      expectedSha256: options.expectedSha256,
    });

    this.logger.log(JSON.stringify(result));
  }
}
