import { Injectable } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import { FeatureFlagKey } from 'twenty-shared/types';
import { isDefined } from 'twenty-shared/utils';
import { type DataSource, type QueryRunner } from 'typeorm';

import { PostgresAdvisoryLockService } from 'src/database/typeorm/postgres-advisory-lock.service';
import { FeatureFlagService } from 'src/engine/core-modules/feature-flag/services/feature-flag.service';
import { buildSearchVectorTriggerStatements } from 'src/engine/core-modules/search-vector-trigger/utils/build-search-vector-trigger-statements.util';
import { upsertSearchVectorBackfillJob } from 'src/engine/core-modules/search-vector-trigger/utils/search-vector-backfill.util';
import {
  countSearchVectorMismatches,
  getSearchVectorColumnState,
  MISMATCH_CHECK_STATEMENT_TIMEOUT,
  checkSearchVectorIndex,
  type SearchVectorIndexHealth,
  selectMismatchCount,
  selectRowCount,
  withLongQueryRunner,
} from 'src/engine/core-modules/search-vector-trigger/utils/search-vector-table-queries.util';
import {
  buildSearchVectorTablePlans,
  convertGeneratedSearchVectorColumn,
  getSearchVectorConversionLockName,
  haveSearchVectorTablePlansChanged,
  installSearchVectorTrigger,
  isLockNotAvailableError,
  isSearchVectorTriggerMode,
  type SearchVectorTablePlan,
  type SearchVectorUnplannedTable,
} from 'src/engine/core-modules/search-vector-trigger/utils/search-vector-trigger-maintenance.util';
import { WorkspaceCacheService } from 'src/engine/workspace-cache/services/workspace-cache.service';
import {
  assertSafeTsVectorExpression,
  escapeIdentifier,
} from 'src/engine/workspace-manager/workspace-migration/utils/remove-sql-injection.util';

export type SearchVectorTableConversionResult = {
  status:
    | 'converted'
    | 'alreadyConverted'
    | 'mismatch'
    | 'needsRepair'
    | 'repaired'
    | 'dryRun'
    | 'lockTimeout';
  mismatchCount: number;
};

export type SearchVectorTableConversionReportRow = {
  tableName: string;
  status:
    | SearchVectorTableConversionResult['status']
    | 'skipped'
    | 'blocked'
    | 'failed';
  mismatchCount: number;
  indexHealth?: SearchVectorIndexHealth | 'repaired';
  error?: string;
  note?: string;
};

export type SearchVectorWorkspaceTablePlans = {
  plans: SearchVectorTablePlan[];
  unplannedTables: SearchVectorUnplannedTable[];
};

export type SearchVectorWorkspaceConversionReport = {
  // changed: a search list changed between the check and the lock; a rerun converts.
  status:
    | 'converted'
    | 'mismatch'
    | 'blocked'
    | 'busy'
    | 'changed'
    | 'dryRun'
    | 'incomplete';
  tables: SearchVectorTableConversionReportRow[];
};

type SearchVectorTable = Omit<SearchVectorTablePlan, 'objectMetadataId'>;

const qualifyTable = ({
  schemaName,
  tableName,
}: Pick<SearchVectorTable, 'schemaName' | 'tableName'>): string =>
  `${escapeIdentifier(schemaName)}.${escapeIdentifier(tableName)}`;

// mismatchCounts follows plans, one count per table.
type SearchVectorWorkspaceCheck = SearchVectorWorkspaceTablePlans & {
  report: SearchVectorWorkspaceConversionReport;
  mismatchCounts: number[];
};

// Repairs a mismatched table instead of refusing it, and queues the backfill that rewrites its rows.
type SearchVectorTableRepair = {
  workspaceId: string;
  objectMetadataId: string;
};

const CONVERSION_LOCK_TIMEOUT = '8s';
const CONVERSION_LOCK_ATTEMPTS = 5;
const CONVERSION_LOCK_RETRY_DELAY_MS = 2000;
const DONE_TABLE_STATUSES: SearchVectorTableConversionReportRow['status'][] = [
  'converted',
  'alreadyConverted',
  'repaired',
];

const toRepair = (
  workspaceId: string,
  plan: SearchVectorTablePlan,
): SearchVectorTableRepair => ({
  workspaceId,
  objectMetadataId: plan.objectMetadataId,
});

@Injectable()
export class SearchVectorTriggerConversionService {
  constructor(
    @InjectDataSource() private readonly dataSource: DataSource,
    private readonly workspaceCacheService: WorkspaceCacheService,
    private readonly featureFlagService: FeatureFlagService,
    private readonly postgresAdvisoryLockService: PostgresAdvisoryLockService,
  ) {}

  async buildWorkspaceTablePlans(
    workspaceId: string,
    { refreshCache }: { refreshCache: boolean },
  ): Promise<SearchVectorWorkspaceTablePlans> {
    const mapKeys = [
      'flatObjectMetadataMaps',
      'flatFieldMetadataMaps',
      'flatSearchFieldMetadataMaps',
      'flatIndexMaps',
    ] as const;
    if (refreshCache) {
      await this.workspaceCacheService.invalidateAndRecompute(workspaceId, [
        ...mapKeys,
      ]);
    }

    const {
      flatObjectMetadataMaps,
      flatFieldMetadataMaps,
      flatSearchFieldMetadataMaps,
      flatIndexMaps,
    } = await this.workspaceCacheService.getOrRecompute(workspaceId, [
      ...mapKeys,
    ]);

    return buildSearchVectorTablePlans({
      workspaceId,
      flatObjectMetadataMaps,
      flatFieldMetadataMaps,
      flatSearchFieldMetadataMaps,
      flatIndexMaps,
    });
  }

  async convertWorkspace({
    workspaceId,
    dryRun,
    repair = false,
  }: {
    workspaceId: string;
    dryRun: boolean;
    repair?: boolean;
  }): Promise<SearchVectorWorkspaceConversionReport> {
    // The long scans run without the workspace lock, so migrations keep working meanwhile.
    const checked = await this.checkWorkspace({ workspaceId, dryRun, repair });

    if (dryRun || checked.report.status !== 'dryRun') {
      return this.checkIndexes({
        report: checked.report,
        plans: checked.plans,
        repair: false,
      });
    }

    for (let attempt = 1; attempt <= CONVERSION_LOCK_ATTEMPTS; attempt++) {
      const lockResult = await this.postgresAdvisoryLockService.tryWithLock(
        getSearchVectorConversionLockName(workspaceId),
        () => this.switchWorkspace({ workspaceId, repair, checked }),
      );

      if (lockResult.acquired) {
        const report =
          lockResult.value.status === 'converted'
            ? await this.verifyWorkspace({
                workspaceId,
                report: lockResult.value,
                plans: checked.plans,
              })
            : lockResult.value;

        // After the lock is released: a concurrent index build waits out every open transaction.
        return this.checkIndexes({
          report,
          plans: checked.plans,
          repair: repair && report.status === 'converted',
        });
      }

      if (attempt < CONVERSION_LOCK_ATTEMPTS) {
        await new Promise((resolve) =>
          setTimeout(resolve, CONVERSION_LOCK_RETRY_DELAY_MS),
        );
      }
    }

    // A migration of this workspace kept the lock; a rerun converts once it is done.
    return { status: 'busy', tables: [] };
  }

  // Check every table before converting any, so a mismatch on a late table cannot leave the
  // workspace half-converted.
  private async checkWorkspace({
    workspaceId,
    dryRun,
    repair,
  }: {
    workspaceId: string;
    dryRun: boolean;
    repair: boolean;
  }): Promise<SearchVectorWorkspaceCheck> {
    const { plans, unplannedTables } = await this.buildWorkspaceTablePlans(
      workspaceId,
      { refreshCache: !dryRun },
    );
    const checks: SearchVectorWorkspaceConversionReport['tables'] = [
      ...unplannedTables,
    ];
    const mismatchCounts: number[] = [];

    for (const plan of plans) {
      try {
        const check = await this.checkTable({
          ...plan,
          repair: repair ? toRepair(workspaceId, plan) : undefined,
        });

        checks.push({ tableName: plan.tableName, ...check });
        mismatchCounts.push(check.mismatchCount);
      } catch (error) {
        // Reported per table, so the run still reports every other table.
        checks.push({
          tableName: plan.tableName,
          status: 'failed',
          mismatchCount: 0,
          error: error instanceof Error ? error.message : String(error),
        });
        mismatchCounts.push(0);
      }
    }

    const status = checks.some((check) => check.status === 'failed')
      ? 'incomplete'
      : checks.some((check) => check.status === 'blocked')
        ? 'blocked'
        : checks.some((check) => check.status === 'mismatch')
          ? 'mismatch'
          : 'dryRun';

    return {
      report: { status, tables: checks },
      plans,
      unplannedTables,
      mismatchCounts,
    };
  }

  // Runs under the exclusive workspace lock, which only covers the quick DDL of each table.
  private async switchWorkspace({
    workspaceId,
    repair,
    checked,
  }: {
    workspaceId: string;
    repair: boolean;
    checked: SearchVectorWorkspaceCheck;
  }): Promise<SearchVectorWorkspaceConversionReport> {
    const { plans } = await this.buildWorkspaceTablePlans(workspaceId, {
      refreshCache: true,
    });

    // A migration ran between the check and the lock; the checked formulas may be stale.
    if (haveSearchVectorTablePlansChanged(checked.plans, plans)) {
      return { status: 'changed', tables: checked.report.tables };
    }

    // Stop at the first table that is not done, so a rerun picks up from a known point.
    const conversions: SearchVectorWorkspaceConversionReport['tables'] = [
      ...checked.unplannedTables,
    ];

    for (const [index, plan] of checked.plans.entries()) {
      try {
        const conversion = await this.switchTable({
          ...plan,
          mismatchCount: checked.mismatchCounts[index],
          repair: repair ? toRepair(workspaceId, plan) : undefined,
        });

        conversions.push({ tableName: plan.tableName, ...conversion });

        if (!DONE_TABLE_STATUSES.includes(conversion.status)) {
          return {
            status:
              conversion.status === 'mismatch' ? 'mismatch' : 'incomplete',
            tables: conversions,
          };
        }
      } catch (error) {
        // Earlier tables may already be converted; report them instead of throwing so the
        // caller sees a partial state; a rerun finishes the job.
        conversions.push({
          tableName: plan.tableName,
          status: 'failed',
          mismatchCount: 0,
          error: error instanceof Error ? error.message : String(error),
        });

        return { status: 'incomplete', tables: conversions };
      }
    }

    // Set under the lock, so the next migration already creates new tables in trigger mode.
    await this.featureFlagService.upsertWorkspaceFeatureFlag({
      workspaceId,
      featureFlag: FeatureFlagKey.IS_SEARCH_VECTOR_TRIGGER_ENABLED,
      value: true,
    });

    return { status: 'converted', tables: conversions };
  }

  // Airtight: this scan's snapshot starts after the DDL committed, so it sees every row written
  // before the switch, and every row written after went through the trigger.
  private async verifyWorkspace({
    workspaceId,
    report,
    plans,
  }: {
    workspaceId: string;
    report: SearchVectorWorkspaceConversionReport;
    plans: SearchVectorTablePlan[];
  }): Promise<SearchVectorWorkspaceConversionReport> {
    const tables: SearchVectorWorkspaceConversionReport['tables'] = [];

    for (const table of report.tables) {
      const plan = plans.find(
        (tablePlan) => tablePlan.tableName === table.tableName,
      );

      if (table.status !== 'converted' || !isDefined(plan)) {
        tables.push(table);
        continue;
      }

      try {
        const mismatchCount = await withLongQueryRunner(
          this.dataSource,
          (queryRunner) =>
            countSearchVectorMismatches(
              queryRunner,
              qualifyTable(plan),
              plan.leanColumnExpression,
            ),
        );

        if (mismatchCount === 0) {
          tables.push(table);
          continue;
        }

        // The upsert locks the active job row, so it runs in a transaction.
        await this.dataSource.transaction((entityManager) =>
          this.queueRepairBackfill(
            entityManager.queryRunner as QueryRunner,
            toRepair(workspaceId, plan),
          ),
        );

        tables.push({
          tableName: table.tableName,
          status: 'repaired',
          mismatchCount,
          note: 'rows written during the switch, queued for backfill',
        });
      } catch (error) {
        tables.push({
          ...table,
          status: 'failed',
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }

    return {
      status: tables.some((table) => table.status === 'failed')
        ? 'incomplete'
        : 'converted',
      tables,
    };
  }

  // Reported on every run; with --repair a broken GIN is rebuilt concurrently.
  private async checkIndexes({
    report,
    plans,
    repair,
  }: {
    report: SearchVectorWorkspaceConversionReport;
    plans: SearchVectorTablePlan[];
    repair: boolean;
  }): Promise<SearchVectorWorkspaceConversionReport> {
    const tables: SearchVectorWorkspaceConversionReport['tables'] = [];

    for (const table of report.tables) {
      const plan = plans.find(
        (tablePlan) => tablePlan.tableName === table.tableName,
      );

      if (!isDefined(plan) || table.status === 'failed') {
        tables.push(table);
        continue;
      }

      try {
        const indexHealth = await withLongQueryRunner(
          this.dataSource,
          (queryRunner) =>
            checkSearchVectorIndex(queryRunner, {
              schemaName: plan.schemaName,
              qualifiedTable: qualifyTable(plan),
              indexName: plan.searchVectorIndexName,
              repair,
            }),
          repair ? 0 : undefined,
        );

        tables.push({
          ...table,
          indexHealth,
          ...(isDefined(plan.searchVectorIndexName) || indexHealth === 'healthy'
            ? {}
            : { note: 'no searchVector index in metadata, not rebuilt' }),
        });
      } catch (error) {
        tables.push({
          ...table,
          status: 'failed',
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }

    const hasFailedIndexCheck =
      (report.status === 'converted' || report.status === 'dryRun') &&
      tables.some((table) => table.status === 'failed');

    return {
      status: hasFailedIndexCheck ? 'incomplete' : report.status,
      tables,
    };
  }

  // Checks and switches one table, as one run would.
  async convertTable({
    dryRun,
    repair,
    lockTimeout,
    ...table
  }: SearchVectorTable & {
    dryRun: boolean;
    repair?: SearchVectorTableRepair;
    lockTimeout?: string;
  }): Promise<SearchVectorTableConversionResult> {
    const check = await this.checkTable({ ...table, repair });

    if (dryRun || check.status === 'mismatch') {
      return check;
    }

    return this.switchTable({
      ...table,
      mismatchCount: check.mismatchCount,
      repair,
      lockTimeout,
    });
  }

  // Read-only and lock-free: only the scan's own snapshot.
  async checkTable({
    schemaName,
    tableName,
    leanColumnExpression,
    repair,
  }: SearchVectorTable & {
    repair?: SearchVectorTableRepair;
  }): Promise<SearchVectorTableConversionResult> {
    assertSafeTsVectorExpression(leanColumnExpression);

    return withLongQueryRunner(this.dataSource, async (queryRunner) => {
      const columnState = await getSearchVectorColumnState(
        queryRunner,
        schemaName,
        tableName,
      );

      // Every row needs its vector written, so a missing column is a repair of the whole table.
      if (columnState === 'missing') {
        if (!isDefined(repair)) {
          throw new Error(
            `searchVector column not found on ${schemaName}.${tableName}; rerun with --repair`,
          );
        }

        return {
          status: 'needsRepair',
          mismatchCount: await selectRowCount(
            queryRunner,
            qualifyTable({ schemaName, tableName }),
          ),
        };
      }

      const mismatchCount = await countSearchVectorMismatches(
        queryRunner,
        qualifyTable({ schemaName, tableName }),
        leanColumnExpression,
      );

      // A plain column of unknown origin may hold NULL or stale vectors; installing a trigger
      // would only fix rows on their next write, so it needs --repair like a generated one.
      if (mismatchCount > 0) {
        return {
          status: isDefined(repair) ? 'needsRepair' : 'mismatch',
          mismatchCount,
        };
      }

      // Only a working trigger makes a plain column converted; without one the next write
      // goes stale, so the table still needs converting.
      const hasTrigger = await isSearchVectorTriggerMode(queryRunner, {
        schemaName,
        tableName,
      });

      return {
        status: hasTrigger ? 'alreadyConverted' : 'dryRun',
        mismatchCount: 0,
      };
    });
  }

  // The quick DDL only; mismatchCount comes from the check and decides the REPAIR job.
  async switchTable({
    schemaName,
    tableName,
    leanColumnExpression,
    triggerRowExpression,
    mismatchCount,
    repair,
    lockTimeout = CONVERSION_LOCK_TIMEOUT,
  }: SearchVectorTable & {
    mismatchCount: number;
    repair?: SearchVectorTableRepair;
    lockTimeout?: string;
  }): Promise<SearchVectorTableConversionResult> {
    if (!/^\d+(ms|s)$/.test(lockTimeout)) {
      throw new Error(`Invalid lock timeout: ${lockTimeout}`);
    }

    assertSafeTsVectorExpression(leanColumnExpression);

    const qualifiedTable = qualifyTable({ schemaName, tableName });
    const statements = buildSearchVectorTriggerStatements({
      schemaName,
      tableName,
      triggerRowExpression,
    });

    return withLongQueryRunner(this.dataSource, async (queryRunner) => {
      try {
        const columnState = await getSearchVectorColumnState(
          queryRunner,
          schemaName,
          tableName,
        );
        const hasTrigger = await isSearchVectorTriggerMode(queryRunner, {
          schemaName,
          tableName,
        });

        await queryRunner.startTransaction();
        await queryRunner.query(`SET LOCAL lock_timeout = '${lockTimeout}'`);

        let repairedRowCount = mismatchCount;

        if (columnState === 'generated') {
          await convertGeneratedSearchVectorColumn({
            queryRunner,
            qualifiedTable,
            statements,
            triggerRowExpression,
          });
        } else {
          // A repair rewrites every row through its backfill, so a write after the scan is
          // covered. Otherwise nothing maintains the column yet: block writes and recheck.
          if (columnState === 'missing') {
            // No default, so Postgres adds it without rewriting the table; the backfill fills it.
            await queryRunner.query(
              `ALTER TABLE ${qualifiedTable} ADD COLUMN "searchVector" tsvector`,
            );
          } else if (repairedRowCount === 0 && !hasTrigger) {
            await queryRunner.query(
              `LOCK TABLE ${qualifiedTable} IN SHARE ROW EXCLUSIVE MODE`,
            );
            await queryRunner.query(
              `SET LOCAL statement_timeout = '${MISMATCH_CHECK_STATEMENT_TIMEOUT}'`,
            );
            repairedRowCount = await selectMismatchCount(
              queryRunner,
              qualifiedTable,
              leanColumnExpression,
            );

            if (repairedRowCount > 0 && !isDefined(repair)) {
              await queryRunner.rollbackTransaction();

              return { status: 'mismatch', mismatchCount: repairedRowCount };
            }
          }

          await installSearchVectorTrigger({
            queryRunner,
            qualifiedTable,
            statements,
            triggerRowExpression,
          });
        }

        // Same transaction as the trigger, so a repaired table always has its backfill.
        if (repairedRowCount > 0) {
          await this.queueRepairBackfill(queryRunner, repair);
        }

        await queryRunner.commitTransaction();

        if (repairedRowCount > 0) {
          return { status: 'repaired', mismatchCount: repairedRowCount };
        }

        return {
          status: hasTrigger ? 'alreadyConverted' : 'converted',
          mismatchCount: 0,
        };
      } catch (error) {
        if (queryRunner.isTransactionActive) {
          try {
            await queryRunner.rollbackTransaction();
          } catch {
            // Keep the original error; a failed rollback must not mask it.
          }
        }

        if (isLockNotAvailableError(error)) {
          return { status: 'lockTimeout', mismatchCount: 0 };
        }

        throw error;
      }
    });
  }

  private async queueRepairBackfill(
    queryRunner: QueryRunner,
    repair: SearchVectorTableRepair | undefined,
  ): Promise<void> {
    if (!isDefined(repair)) {
      throw new Error('A mismatched table can only be converted with --repair');
    }

    await upsertSearchVectorBackfillJob(queryRunner, {
      ...repair,
      request: { reason: 'REPAIR', filter: null },
    });
  }
}
