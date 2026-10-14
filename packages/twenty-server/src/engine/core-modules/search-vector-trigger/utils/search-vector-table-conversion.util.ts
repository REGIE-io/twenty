import { isDefined } from 'twenty-shared/utils';
import { type DataSource, type QueryRunner } from 'typeorm';

import { buildSearchVectorTriggerStatements } from 'src/engine/core-modules/search-vector-trigger/utils/build-search-vector-trigger-statements.util';
import { upsertSearchVectorBackfillJob } from 'src/engine/core-modules/search-vector-trigger/utils/search-vector-backfill.util';
import {
  checkSearchVectorIndex,
  countSearchVectorMismatches,
  getSearchVectorColumnState,
  MISMATCH_CHECK_STATEMENT_TIMEOUT,
  type SearchVectorIndexHealth,
  selectMismatchCount,
  selectRowCount,
  withLongQueryRunner,
} from 'src/engine/core-modules/search-vector-trigger/utils/search-vector-table-queries.util';
import {
  convertGeneratedSearchVectorColumn,
  installSearchVectorTrigger,
  isLockNotAvailableError,
  isSearchVectorTriggerMode,
  type SearchVectorTablePlan,
} from 'src/engine/core-modules/search-vector-trigger/utils/search-vector-trigger-maintenance.util';
import {
  assertSafeTsVectorExpression,
  escapeIdentifier,
} from 'src/engine/workspace-manager/workspace-migration/utils/remove-sql-injection.util';

// The per-table steps of a conversion; the service runs them per workspace under its lock.

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

export type SearchVectorTable = Omit<SearchVectorTablePlan, 'objectMetadataId'>;

// Repairs a mismatched table instead of refusing it, and queues the backfill that rewrites its rows.
export type SearchVectorTableRepair = {
  workspaceId: string;
  objectMetadataId: string;
};

export const CONVERSION_LOCK_TIMEOUT = '8s';

export const qualifyTable = ({
  schemaName,
  tableName,
}: Pick<SearchVectorTable, 'schemaName' | 'tableName'>): string =>
  `${escapeIdentifier(schemaName)}.${escapeIdentifier(tableName)}`;

export const toRepair = (
  workspaceId: string,
  plan: SearchVectorTablePlan,
): SearchVectorTableRepair => ({
  workspaceId,
  objectMetadataId: plan.objectMetadataId,
});

const toErrorMessage = (error: unknown): string =>
  error instanceof Error ? error.message : String(error);

const queueRepairBackfill = async (
  queryRunner: QueryRunner,
  repair: SearchVectorTableRepair | undefined,
): Promise<void> => {
  if (!isDefined(repair)) {
    throw new Error('A mismatched table can only be converted with --repair');
  }

  await upsertSearchVectorBackfillJob(queryRunner, {
    ...repair,
    request: { reason: 'REPAIR', filter: null },
  });
};

// Read-only and lock-free: only the scan's own snapshot.
export const checkSearchVectorTable = async (
  dataSource: DataSource,
  {
    schemaName,
    tableName,
    leanColumnExpression,
    repair,
  }: SearchVectorTable & { repair?: SearchVectorTableRepair },
): Promise<SearchVectorTableConversionResult> => {
  assertSafeTsVectorExpression(leanColumnExpression);

  return withLongQueryRunner(dataSource, async (queryRunner) => {
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
};

// The quick DDL only; mismatchCount comes from the check and decides the REPAIR job.
export const switchSearchVectorTable = async (
  dataSource: DataSource,
  {
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
  },
): Promise<SearchVectorTableConversionResult> => {
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

  return withLongQueryRunner(dataSource, async (queryRunner) => {
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
        await queueRepairBackfill(queryRunner, repair);
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
};

// Airtight: this scan's snapshot starts after the DDL committed, so it sees every row written
// before the switch, and every row written after went through the trigger.
export const verifySearchVectorTables = async (
  dataSource: DataSource,
  {
    workspaceId,
    tables,
    plans,
  }: {
    workspaceId: string;
    tables: SearchVectorTableConversionReportRow[];
    plans: SearchVectorTablePlan[];
  },
): Promise<SearchVectorTableConversionReportRow[]> => {
  const verifiedTables: SearchVectorTableConversionReportRow[] = [];

  for (const table of tables) {
    const plan = plans.find(
      (tablePlan) => tablePlan.tableName === table.tableName,
    );

    if (table.status !== 'converted' || !isDefined(plan)) {
      verifiedTables.push(table);
      continue;
    }

    try {
      const mismatchCount = await withLongQueryRunner(
        dataSource,
        (queryRunner) =>
          countSearchVectorMismatches(
            queryRunner,
            qualifyTable(plan),
            plan.leanColumnExpression,
          ),
      );

      if (mismatchCount === 0) {
        verifiedTables.push(table);
        continue;
      }

      // The upsert locks the active job row, so it runs in a transaction.
      await dataSource.transaction((entityManager) =>
        queueRepairBackfill(
          entityManager.queryRunner as QueryRunner,
          toRepair(workspaceId, plan),
        ),
      );

      verifiedTables.push({
        tableName: table.tableName,
        status: 'repaired',
        mismatchCount,
        note: 'rows written during the switch, queued for backfill',
      });
    } catch (error) {
      verifiedTables.push({
        ...table,
        status: 'failed',
        error: toErrorMessage(error),
      });
    }
  }

  return verifiedTables;
};

// Reported on every run; with --repair a broken GIN is rebuilt concurrently, without the client
// timeout, so a long build is not reported failed while the server still runs it.
export const checkSearchVectorIndexes = async (
  dataSource: DataSource,
  {
    tables,
    plans,
    repair,
  }: {
    tables: SearchVectorTableConversionReportRow[];
    plans: SearchVectorTablePlan[];
    repair: boolean;
  },
): Promise<SearchVectorTableConversionReportRow[]> => {
  const checkedTables: SearchVectorTableConversionReportRow[] = [];

  for (const table of tables) {
    const plan = plans.find(
      (tablePlan) => tablePlan.tableName === table.tableName,
    );

    if (!isDefined(plan) || table.status === 'failed') {
      checkedTables.push(table);
      continue;
    }

    try {
      const indexHealth = await withLongQueryRunner(
        dataSource,
        (queryRunner) =>
          checkSearchVectorIndex(queryRunner, {
            schemaName: plan.schemaName,
            qualifiedTable: qualifyTable(plan),
            indexName: plan.searchVectorIndexName,
            repair,
          }),
        repair ? 0 : undefined,
      );

      checkedTables.push({
        ...table,
        indexHealth,
        ...(isDefined(plan.searchVectorIndexName) || indexHealth === 'healthy'
          ? {}
          : { note: 'no searchVector index in metadata, not rebuilt' }),
      });
    } catch (error) {
      checkedTables.push({
        ...table,
        status: 'failed',
        error: toErrorMessage(error),
      });
    }
  }

  return checkedTables;
};
