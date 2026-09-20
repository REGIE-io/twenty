import { Logger } from '@nestjs/common';

import { Command, CommandRunner, Option } from 'nest-commander';

import { RegieLegacyE2eOrphanMarkerBackfillService } from 'src/engine/workspace-manager/workspace-cleaner/services/regie-legacy-e2e-orphan-marker-backfill.service';

type BackfillOptions = {
  apply?: boolean;
  createdBefore?: string;
  expectedCount?: number;
  expectedSha256?: string;
};

@Command({
  name: 'workspace:backfill-regie-legacy-e2e-orphan-markers',
  description:
    'Dry-run or authorize reviewed legacy Regie E2E orphans for delayed deletion',
})
export class BackfillRegieLegacyE2eOrphanMarkersCommand extends CommandRunner {
  private readonly logger = new Logger(
    BackfillRegieLegacyE2eOrphanMarkersCommand.name,
  );

  constructor(
    private readonly backfill: RegieLegacyE2eOrphanMarkerBackfillService,
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
    description: 'Write authorization markers; omission is always a dry run',
  })
  parseApply(): boolean {
    return true;
  }

  async run(_passedParams: string[], options: BackfillOptions): Promise<void> {
    if (!options.createdBefore) {
      throw new Error('--created-before is required');
    }

    const result = await this.backfill.run({
      apply: options.apply === true,
      createdBefore: options.createdBefore,
      expectedCount: options.expectedCount,
      expectedSha256: options.expectedSha256,
    });

    this.logger.log(JSON.stringify(result));
  }
}
