import { Injectable } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import { isDefined } from 'twenty-shared/utils';
import { type DataSource, type QueryRunner } from 'typeorm';

import { POSTGRESQL_ERROR_CODES } from 'src/engine/api/graphql/workspace-query-runner/constants/postgres-error-codes.constants';
import {
  buildSearchVectorTriggerStatements,
  type SearchVectorTriggerStatements,
} from 'src/engine/core-modules/search-vector-trigger/utils/build-search-vector-trigger-statements.util';
import {
  getSearchVectorColumnState,
  hasSearchVectorTrigger,
  selectMismatchCount,
} from 'src/engine/core-modules/search-vector-trigger/utils/search-vector-table-queries.util';
import { findManyFlatEntityByIdInFlatEntityMaps } from 'src/engine/metadata-modules/flat-entity/utils/find-many-flat-entity-by-id-in-flat-entity-maps.util';
import { deriveCheckedSearchVectorExpression } from 'src/engine/metadata-modules/flat-search-field-metadata/utils/derive-checked-search-vector-expression.util';
import { findTsVectorFlatFieldMetadataForObject } from 'src/engine/metadata-modules/flat-search-field-metadata/utils/find-ts-vector-flat-field-metadata-for-object.util';
import { getTargetSearchFieldMetadatasForTsVectorField } from 'src/engine/metadata-modules/flat-search-field-metadata/utils/get-target-search-field-metadatas-for-ts-vector-field.util';
import { computeObjectTargetTable } from 'src/engine/utils/compute-object-target-table.util';
import { WorkspaceCacheService } from 'src/engine/workspace-cache/services/workspace-cache.service';
import { getWorkspaceSchemaName } from 'src/engine/workspace-datasource/utils/get-workspace-schema-name.util';
import {
  assertSafeTsVectorExpression,
  escapeIdentifier,
} from 'src/engine/workspace-manager/workspace-migration/utils/remove-sql-injection.util';

export type SearchVectorTableConversionResult = {
  status:
    | 'converted'
    | 'alreadyConverted'
    | 'mismatch'
    | 'dryRun'
    | 'lockTimeout';
  mismatchCount: number;
};

export type SearchVectorTablePlan = {
  schemaName: string;
  tableName: string;
  leanColumnExpression: string;
  triggerRowExpression: string;
};

export type SearchVectorTableConversionReportRow = {
  tableName: string;
  status: SearchVectorTableConversionResult['status'] | 'failed';
  mismatchCount: number;
  error?: string;
};

export type SearchVectorWorkspaceConversionReport = {
  status: 'converted' | 'mismatch' | 'dryRun' | 'incomplete';
  tables: SearchVectorTableConversionReportRow[];
};

type TimeoutAdjustableQueryRunner = QueryRunner & {
  databaseConnection?: {
    query_timeout?: number;
    connectionParameters?: { query_timeout?: number };
  };
};

const CONVERSION_LOCK_TIMEOUT = '8s';
const MISMATCH_CHECK_STATEMENT_TIMEOUT = '30min';
const CLIENT_QUERY_TIMEOUT_MS = 35 * 60 * 1000;

@Injectable()
export class SearchVectorTriggerConversionService {
  constructor(
    @InjectDataSource() private readonly dataSource: DataSource,
    private readonly workspaceCacheService: WorkspaceCacheService,
  ) {}

  async buildWorkspaceTablePlans(
    workspaceId: string,
    { refreshCache }: { refreshCache: boolean },
  ): Promise<SearchVectorTablePlan[]> {
    const mapKeys = [
      'flatObjectMetadataMaps',
      'flatFieldMetadataMaps',
      'flatSearchFieldMetadataMaps',
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
    } = await this.workspaceCacheService.getOrRecompute(workspaceId, [
      ...mapKeys,
    ]);

    const plans: SearchVectorTablePlan[] = [];

    for (const flatObjectMetadata of Object.values(
      flatObjectMetadataMaps.byUniversalIdentifier,
    )) {
      if (!isDefined(flatObjectMetadata)) {
        continue;
      }

      const tsVectorField = findTsVectorFlatFieldMetadataForObject({
        fieldUniversalIdentifiers: flatObjectMetadata.fieldUniversalIdentifiers,
        flatFieldMetadataMaps,
      });

      if (!isDefined(tsVectorField)) {
        continue;
      }

      const objectFlatFieldMetadatas = findManyFlatEntityByIdInFlatEntityMaps({
        flatEntityMaps: flatFieldMetadataMaps,
        flatEntityIds: flatObjectMetadata.fieldIds,
      });
      const targetSearchFieldMetadatas =
        getTargetSearchFieldMetadatasForTsVectorField({
          tsVectorFieldMetadataId: tsVectorField.id,
          flatSearchFieldMetadataMaps,
        });

      const expressionInput = {
        flatObjectMetadata,
        objectFlatFieldMetadatas,
        targetSearchFieldMetadatas,
      };

      plans.push({
        schemaName: getWorkspaceSchemaName(workspaceId),
        tableName: computeObjectTargetTable(flatObjectMetadata),
        leanColumnExpression: deriveCheckedSearchVectorExpression({
          ...expressionInput,
          shape: 'leanColumn',
        }),
        triggerRowExpression: deriveCheckedSearchVectorExpression({
          ...expressionInput,
          shape: 'triggerRow',
        }),
      });
    }

    return plans;
  }

  async convertWorkspace({
    workspaceId,
    dryRun,
  }: {
    workspaceId: string;
    dryRun: boolean;
  }): Promise<SearchVectorWorkspaceConversionReport> {
    const plans = await this.buildWorkspaceTablePlans(workspaceId, {
      refreshCache: !dryRun,
    });

    // Check every table before converting any, so a mismatch on a late table cannot leave
    // the workspace half-converted.
    const checks: SearchVectorWorkspaceConversionReport['tables'] = [];

    for (const plan of plans) {
      const check = await this.convertTable({ ...plan, dryRun: true });

      checks.push({ tableName: plan.tableName, ...check });
    }

    if (checks.some((check) => check.status === 'mismatch')) {
      return { status: 'mismatch', tables: checks };
    }

    if (dryRun) {
      return { status: 'dryRun', tables: checks };
    }

    // Each table is re-checked here on purpose: rows may have changed since phase 1. Stop at
    // the first table that is not done, so a rerun picks up from a known point.
    const conversions: SearchVectorWorkspaceConversionReport['tables'] = [];

    for (const plan of plans) {
      try {
        const conversion = await this.convertTable({ ...plan, dryRun: false });

        conversions.push({ tableName: plan.tableName, ...conversion });

        if (
          conversion.status !== 'converted' &&
          conversion.status !== 'alreadyConverted'
        ) {
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

    // PR 2 records the workspace as converted here, once the runner can keep trigger mode.
    return { status: 'converted', tables: conversions };
  }

  async convertTable({
    schemaName,
    tableName,
    leanColumnExpression,
    triggerRowExpression,
    dryRun,
    lockTimeout = CONVERSION_LOCK_TIMEOUT,
  }: {
    schemaName: string;
    tableName: string;
    leanColumnExpression: string;
    triggerRowExpression: string;
    dryRun: boolean;
    lockTimeout?: string;
  }): Promise<SearchVectorTableConversionResult> {
    if (!/^\d+(ms|s)$/.test(lockTimeout)) {
      throw new Error(`Invalid lock timeout: ${lockTimeout}`);
    }

    assertSafeTsVectorExpression(leanColumnExpression);

    const qualifiedTable = `${escapeIdentifier(schemaName)}.${escapeIdentifier(tableName)}`;
    const statements = buildSearchVectorTriggerStatements({
      schemaName,
      tableName,
      triggerRowExpression,
    });

    const queryRunner = this.dataSource.createQueryRunner();
    let restoreClientTimeout: () => void = () => {};

    try {
      await queryRunner.connect();
      restoreClientTimeout = this.raiseClientQueryTimeout(queryRunner);

      const columnState = await getSearchVectorColumnState(
        queryRunner,
        schemaName,
        tableName,
      );

      if (columnState === 'missing') {
        throw new Error(
          `searchVector column not found on ${schemaName}.${tableName}`,
        );
      }

      if (columnState === 'plain') {
        // A plain column of unknown origin may hold NULL or stale vectors; installing a
        // trigger would only fix rows on their next write, so refuse instead of reporting done.
        const plainMismatchCount = await this.countMismatches(
          queryRunner,
          qualifiedTable,
          leanColumnExpression,
        );

        if (plainMismatchCount > 0) {
          return { status: 'mismatch', mismatchCount: plainMismatchCount };
        }

        const hasTrigger = await hasSearchVectorTrigger(queryRunner, {
          qualifiedTable,
          triggerName: statements.functionName,
          qualifiedFunction: `${escapeIdentifier(schemaName)}.${escapeIdentifier(statements.functionName)}`,
        });

        // Only a working trigger makes a plain column converted; without one the next write
        // goes stale, so the table still needs converting.
        if (dryRun) {
          return {
            status: hasTrigger ? 'alreadyConverted' : 'dryRun',
            mismatchCount: 0,
          };
        }

        await queryRunner.startTransaction();
        await queryRunner.query(`SET LOCAL lock_timeout = '${lockTimeout}'`);

        if (!hasTrigger) {
          // Nothing maintains the column yet, so a write after the scan above would stay
          // stale. Block writes and recheck before installing the trigger.
          await queryRunner.query(
            `LOCK TABLE ${qualifiedTable} IN SHARE ROW EXCLUSIVE MODE`,
          );
          await queryRunner.query(
            `SET LOCAL statement_timeout = '${MISMATCH_CHECK_STATEMENT_TIMEOUT}'`,
          );

          const lockedMismatchCount = await selectMismatchCount(
            queryRunner,
            qualifiedTable,
            leanColumnExpression,
          );

          if (lockedMismatchCount > 0) {
            await queryRunner.rollbackTransaction();

            return { status: 'mismatch', mismatchCount: lockedMismatchCount };
          }
        }

        await this.installTrigger({
          queryRunner,
          qualifiedTable,
          statements,
          triggerRowExpression,
        });
        await queryRunner.commitTransaction();

        return {
          status: hasTrigger ? 'alreadyConverted' : 'converted',
          mismatchCount: 0,
        };
      }

      const mismatchCount = await this.countMismatches(
        queryRunner,
        qualifiedTable,
        leanColumnExpression,
      );

      if (mismatchCount > 0) {
        return { status: 'mismatch', mismatchCount };
      }

      if (dryRun) {
        return { status: 'dryRun', mismatchCount: 0 };
      }

      await queryRunner.startTransaction();
      await queryRunner.query(`SET LOCAL lock_timeout = '${lockTimeout}'`);
      await queryRunner.query(statements.createFunction);
      // Same transaction: after DROP EXPRESSION the column accepts direct writes, so the
      // trigger must exist before anyone else can write the table.
      await queryRunner.query(
        `ALTER TABLE ${qualifiedTable} ALTER COLUMN "searchVector" DROP EXPRESSION`,
      );
      await this.installTrigger({
        queryRunner,
        qualifiedTable,
        statements,
        triggerRowExpression,
        skipCreateFunction: true,
      });
      await queryRunner.commitTransaction();

      return { status: 'converted', mismatchCount: 0 };
    } catch (error) {
      if (queryRunner.isTransactionActive) {
        try {
          await queryRunner.rollbackTransaction();
        } catch {
          // Keep the original error; a failed rollback must not mask it.
        }
      }

      if (this.isLockTimeoutError(error)) {
        return { status: 'lockTimeout', mismatchCount: 0 };
      }

      throw error;
    } finally {
      restoreClientTimeout();
      await queryRunner.release();
    }
  }

  private async installTrigger({
    queryRunner,
    qualifiedTable,
    statements,
    triggerRowExpression,
    skipCreateFunction = false,
  }: {
    queryRunner: QueryRunner;
    qualifiedTable: string;
    statements: SearchVectorTriggerStatements;
    triggerRowExpression: string;
    skipCreateFunction?: boolean;
  }): Promise<void> {
    if (!skipCreateFunction) {
      await queryRunner.query(statements.createFunction);
    }
    await queryRunner.query(statements.dropTrigger);
    await queryRunner.query(statements.createTrigger);
    // Parse-check the trigger body against the table even when it is empty; plpgsql would
    // otherwise only fail at the first write.
    await queryRunner.query(`SET LOCAL search_path = pg_catalog, public`);
    await queryRunner.query(
      `SELECT ${triggerRowExpression} FROM ${qualifiedTable} AS new LIMIT 0`,
    );
    // Runtime check: fire the trigger once so a broken expression rolls the conversion
    // back instead of failing every later write.
    await queryRunner.query(
      `UPDATE ${qualifiedTable} SET "id" = "id" WHERE "id" = (SELECT "id" FROM ${qualifiedTable} LIMIT 1)`,
    );
  }

  private async countMismatches(
    queryRunner: QueryRunner,
    qualifiedTable: string,
    leanColumnExpression: string,
  ): Promise<number> {
    await queryRunner.startTransaction();

    try {
      await queryRunner.query(`SET TRANSACTION READ ONLY`);
      await queryRunner.query(
        `SET LOCAL statement_timeout = '${MISMATCH_CHECK_STATEMENT_TIMEOUT}'`,
      );
      const mismatchCount = await selectMismatchCount(
        queryRunner,
        qualifiedTable,
        leanColumnExpression,
      );

      await queryRunner.commitTransaction();

      return mismatchCount;
    } catch (error) {
      try {
        await queryRunner.rollbackTransaction();
      } catch {
        // Keep the original error.
      }
      throw error;
    }
  }

  // The pg client timer only rejects the promise and never cancels the server query, so the
  // client limit is raised here and the server-side statement_timeout does the cancelling.
  private raiseClientQueryTimeout(queryRunner: QueryRunner): () => void {
    const databaseConnection = (queryRunner as TimeoutAdjustableQueryRunner)
      .databaseConnection;

    if (!isDefined(databaseConnection)) {
      return () => {};
    }

    const originalQueryTimeout = databaseConnection.query_timeout;
    const connectionParameters = databaseConnection.connectionParameters;
    const originalParameterTimeout = connectionParameters?.query_timeout;

    databaseConnection.query_timeout = CLIENT_QUERY_TIMEOUT_MS;
    if (isDefined(connectionParameters)) {
      connectionParameters.query_timeout = CLIENT_QUERY_TIMEOUT_MS;
    }

    return () => {
      databaseConnection.query_timeout = originalQueryTimeout;
      if (isDefined(connectionParameters)) {
        connectionParameters.query_timeout = originalParameterTimeout;
      }
    };
  }

  private isLockTimeoutError(error: unknown): boolean {
    const candidate = error as {
      code?: string;
      driverError?: { code?: string };
    } | null;

    return (
      candidate?.code === POSTGRESQL_ERROR_CODES.LOCK_NOT_AVAILABLE ||
      candidate?.driverError?.code === POSTGRESQL_ERROR_CODES.LOCK_NOT_AVAILABLE
    );
  }
}
