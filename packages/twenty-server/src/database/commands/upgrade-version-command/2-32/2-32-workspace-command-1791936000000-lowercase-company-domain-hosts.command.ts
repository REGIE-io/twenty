import { InjectDataSource } from '@nestjs/typeorm';
import { Command } from 'nest-commander';
import { DataSource, type QueryResult } from 'typeorm';

import { ProvisionedWorkspaceCommandRunner } from 'src/database/commands/command-runners/provisioned-workspace.command-runner';
import { WorkspaceIteratorService } from 'src/database/commands/command-runners/workspace-iterator.service';
import { type RunOnWorkspaceArgs } from 'src/database/commands/command-runners/workspace.command-runner';
import { RegisteredWorkspaceCommand } from 'src/engine/core-modules/upgrade/decorators/registered-workspace-command.decorator';
import { getWorkspaceSchemaName } from 'src/engine/workspace-datasource/utils/get-workspace-schema-name.util';
import { escapeIdentifier } from 'src/engine/workspace-manager/workspace-migration/utils/remove-sql-injection.util';

const BATCH_SIZE = 1000;

// Same rule as normalizeUrlOrigin in twenty-shared: lowercase only the scheme and
// host, and leave values that carry userinfo alone.
const SCHEMED_ORIGIN_PATTERN = String.raw`^(\s*[a-z][a-z0-9+.-]*://[^/?#@]*)(?=[/?#]|$)`;
const SCHEMELESS_HOST_PATTERN = String.raw`^([a-z0-9-]+(?:\.[a-z0-9-]+)+)(?=(?::[0-9]+)?(?:[/?#]|$))`;

const LOWERCASABLE_PREFIX = `coalesce(
  (regexp_match("domainNamePrimaryLinkUrl", $1, 'i'))[1],
  (regexp_match("domainNamePrimaryLinkUrl", $2, 'i'))[1]
)`;

@RegisteredWorkspaceCommand('2.32.0', 1791936000000)
@Command({
  name: 'upgrade:2-32:lowercase-company-domain-hosts',
  description:
    'Lowercase the scheme and host of company domains so duplicate checks can match them exactly',
})
export class LowercaseCompanyDomainHostsCommand extends ProvisionedWorkspaceCommandRunner {
  constructor(
    protected readonly workspaceIteratorService: WorkspaceIteratorService,
    @InjectDataSource() private readonly dataSource: DataSource,
  ) {
    super(workspaceIteratorService);
  }

  override async runOnWorkspace({
    workspaceId,
    options,
  }: RunOnWorkspaceArgs): Promise<void> {
    const schemaName = getWorkspaceSchemaName(workspaceId);
    const companyTable = `${escapeIdentifier(schemaName)}."company"`;
    const candidates = `SELECT id, ${LOWERCASABLE_PREFIX} AS prefix FROM ${companyTable}`;
    const patterns = [SCHEMED_ORIGIN_PATTERN, SCHEMELESS_HOST_PATTERN];
    const queryRunner = this.dataSource.createQueryRunner();

    await queryRunner.connect();
    try {
      const columns: unknown[] = await queryRunner.query(
        `SELECT 1 FROM information_schema.columns
         WHERE table_schema = $1 AND table_name = 'company' AND column_name = 'domainNamePrimaryLinkUrl'`,
        [schemaName],
      );

      if (columns.length === 0) {
        return;
      }

      if (options.dryRun) {
        const [{ count }]: Array<{ count: number }> = await queryRunner.query(
          `SELECT count(*)::int AS count FROM (${candidates}) candidates
           WHERE prefix <> lower(prefix)`,
          patterns,
        );

        this.logger.log(
          `[DRY RUN] ${workspaceId} company: ${count} domains to lowercase`,
        );

        return;
      }

      let lowercased = 0;
      let affected = 0;

      // Each batch commits on its own, so row locks stay short and a rerun resumes.
      do {
        const result: QueryResult = await queryRunner.query(
          `WITH batch AS (
             SELECT id, prefix FROM (${candidates}) candidates
             WHERE prefix <> lower(prefix)
             LIMIT $3
           )
           UPDATE ${companyTable} AS company
           SET "domainNamePrimaryLinkUrl" = lower(batch.prefix) || substr(company."domainNamePrimaryLinkUrl", length(batch.prefix) + 1)
           FROM batch
           WHERE company.id = batch.id`,
          [...patterns, BATCH_SIZE],
          true,
        );

        affected = result.affected ?? 0;
        lowercased += affected;
      } while (affected === BATCH_SIZE);

      this.logger.log(
        `${workspaceId} company: lowercased ${lowercased} domains`,
      );
    } finally {
      await queryRunner.release();
    }
  }
}
