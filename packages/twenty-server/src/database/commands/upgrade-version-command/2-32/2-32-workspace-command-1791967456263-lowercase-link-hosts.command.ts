import { InjectDataSource } from '@nestjs/typeorm';
import chunk from 'lodash.chunk';
import { Command } from 'nest-commander';
import { DataSource, type QueryResult } from 'typeorm';

import { ProvisionedWorkspaceCommandRunner } from 'src/database/commands/command-runners/provisioned-workspace.command-runner';
import { WorkspaceIteratorService } from 'src/database/commands/command-runners/workspace-iterator.service';
import { type RunOnWorkspaceArgs } from 'src/database/commands/command-runners/workspace.command-runner';
import { RegisteredWorkspaceCommand } from 'src/engine/core-modules/upgrade/decorators/registered-workspace-command.decorator';
import { getWorkspaceSchemaName } from 'src/engine/workspace-datasource/utils/get-workspace-schema-name.util';
import { escapeIdentifier } from 'src/engine/workspace-manager/workspace-migration/utils/remove-sql-injection.util';

const BATCH_SIZE = 1000;

// The links that standard duplicate criteria compare exactly.
const LINK_COLUMNS = [
  { table: 'company', column: 'domainNamePrimaryLinkUrl' },
  { table: 'person', column: 'linkedinLinkPrimaryLinkUrl' },
] as const;

// Scheme-less links get normalizeUrlOrigin's host rule; other links only get their scheme and
// host lowercased. Values with userinfo are skipped and paths keep their case.
const SCHEMED_ORIGIN_PATTERN = String.raw`^(\s*[a-z][a-z0-9+.-]*://[^/?#@]*)(?=[/?#]|$)`;
const SCHEMELESS_HOST_PATTERN = String.raw`^([a-z0-9-]+(?:\.[a-z0-9-]+)+)(?=(?::[0-9]+)?(?:[/?#]|$))`;
const PATTERNS = [SCHEMED_ORIGIN_PATTERN, SCHEMELESS_HOST_PATTERN];

const lowercasablePrefix = (link: string) => `coalesce(
  (regexp_match(${link}, $1, 'i'))[1],
  (regexp_match(${link}, $2, 'i'))[1]
)`;

@RegisteredWorkspaceCommand('2.32.0', 1791967456263)
@Command({
  name: 'upgrade:2-32:lowercase-link-hosts',
  description:
    'Lowercase the scheme and host of company domains and person LinkedIn links, which duplicate checks compare exactly',
})
export class LowercaseLinkHostsCommand extends ProvisionedWorkspaceCommandRunner {
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
    const queryRunner = this.dataSource.createQueryRunner();

    await queryRunner.connect();
    try {
      for (const { table, column } of LINK_COLUMNS) {
        const columns: unknown[] = await queryRunner.query(
          `SELECT 1 FROM information_schema.columns
           WHERE table_schema = $1 AND table_name = $2 AND column_name = $3`,
          [schemaName, table, column],
        );

        if (columns.length === 0) {
          continue;
        }

        const target = `${escapeIdentifier(schemaName)}.${escapeIdentifier(table)}`;
        const link = escapeIdentifier(column);
        const candidates = `SELECT id, ${lowercasablePrefix(link)} AS prefix FROM ${target}`;
        // One sequential scan. Paging through the random uuid primary key reads pages at random.
        const rows: Array<{ id: string }> = await queryRunner.query(
          `SELECT id FROM (${candidates}) candidates WHERE prefix <> lower(prefix)`,
          PATTERNS,
        );

        if (options.dryRun) {
          this.logger.log(
            `[DRY RUN] ${workspaceId} ${table}.${column}: ${rows.length} links to lowercase`,
          );

          continue;
        }

        let lowercased = 0;

        // Each batch commits on its own, so row locks stay short.
        for (const ids of chunk(
          rows.map(({ id }) => id),
          BATCH_SIZE,
        )) {
          const result: QueryResult<{ id: string }> = await queryRunner.query(
            `WITH batch AS (
               SELECT id, prefix FROM (${candidates} WHERE id = ANY($3::uuid[])) candidates
               WHERE prefix <> lower(prefix)
             )
             UPDATE ${target} AS target
             SET ${link} = lower(batch.prefix) || substr(target.${link}, length(batch.prefix) + 1)
             FROM batch
             WHERE target.id = batch.id
             RETURNING target.id`,
            [...PATTERNS, ids],
            true,
          );

          lowercased += result.records.length;
        }

        this.logger.log(
          `${workspaceId} ${table}.${column}: lowercased ${lowercased} links`,
        );
      }
    } finally {
      await queryRunner.release();
    }
  }
}
