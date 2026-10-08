import { Injectable } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import { FeatureFlagKey } from 'twenty-shared/types';
import { type DataSource } from 'typeorm';

import { PostgresAdvisoryLockService } from 'src/database/typeorm/postgres-advisory-lock.service';
import { FeatureFlagService } from 'src/engine/core-modules/feature-flag/services/feature-flag.service';
import {
  checkSearchVectorIndexes,
  checkSearchVectorTable,
  switchSearchVectorTable,
  type SearchVectorTable,
  type SearchVectorTableConversionReportRow,
  type SearchVectorTableConversionResult,
  type SearchVectorTableRepair,
  toRepair,
  verifySearchVectorTables,
} from 'src/engine/core-modules/search-vector-trigger/utils/search-vector-table-conversion.util';
import {
  buildSearchVectorTablePlans,
  getSearchVectorConversionLockName,
  haveSearchVectorTablePlansChanged,
  type SearchVectorTablePlan,
  type SearchVectorUnplannedTable,
} from 'src/engine/core-modules/search-vector-trigger/utils/search-vector-trigger-maintenance.util';
import { WorkspaceCacheService } from 'src/engine/workspace-cache/services/workspace-cache.service';

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

// mismatchCounts follows plans, one count per table.
type SearchVectorWorkspaceCheck = SearchVectorWorkspaceTablePlans & {
  report: SearchVectorWorkspaceConversionReport;
  mismatchCounts: number[];
};

const CONVERSION_LOCK_ATTEMPTS = 5;
const CONVERSION_LOCK_RETRY_DELAY_MS = 2000;
const DONE_TABLE_STATUSES: SearchVectorTableConversionReportRow['status'][] = [
  'converted',
  'alreadyConverted',
  'repaired',
];

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

    // A migration of this workspace kept the lock; a rerun converts once it is done. The check is
    // kept for the report, but a rerun scans again, as counts are only valid for their snapshot.
    return { status: 'busy', tables: checked.report.tables };
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

  private async verifyWorkspace({
    workspaceId,
    report,
    plans,
  }: {
    workspaceId: string;
    report: SearchVectorWorkspaceConversionReport;
    plans: SearchVectorTablePlan[];
  }): Promise<SearchVectorWorkspaceConversionReport> {
    const tables = await verifySearchVectorTables(this.dataSource, {
      workspaceId,
      tables: report.tables,
      plans,
    });

    return {
      status: tables.some((table) => table.status === 'failed')
        ? 'incomplete'
        : 'converted',
      tables,
    };
  }

  private async checkIndexes({
    report,
    plans,
    repair,
  }: {
    report: SearchVectorWorkspaceConversionReport;
    plans: SearchVectorTablePlan[];
    repair: boolean;
  }): Promise<SearchVectorWorkspaceConversionReport> {
    const tables = await checkSearchVectorIndexes(this.dataSource, {
      tables: report.tables,
      plans,
      repair,
    });
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

  async checkTable(
    table: SearchVectorTable & { repair?: SearchVectorTableRepair },
  ): Promise<SearchVectorTableConversionResult> {
    return checkSearchVectorTable(this.dataSource, table);
  }

  async switchTable(
    table: SearchVectorTable & {
      mismatchCount: number;
      repair?: SearchVectorTableRepair;
      lockTimeout?: string;
    },
  ): Promise<SearchVectorTableConversionResult> {
    return switchSearchVectorTable(this.dataSource, table);
  }
}
