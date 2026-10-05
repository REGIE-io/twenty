import { Injectable, Logger } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';

import { isDefined } from 'twenty-shared/utils';
import { type DataSource, type QueryRunner } from 'typeorm';

import { ExceptionHandlerService } from 'src/engine/core-modules/exception-handler/exception-handler.service';
import {
  ACTIVE_SEARCH_VECTOR_BACKFILL_JOB_STATUSES_SQL,
  type SearchVectorBackfillJobEntity,
} from 'src/engine/core-modules/search-vector-trigger/entities/search-vector-backfill-job.entity';
import {
  type AddQueryParameter,
  buildSearchVectorBackfillFilterSql,
  selectSearchVectorBackfillJobsToClaim,
} from 'src/engine/core-modules/search-vector-trigger/utils/search-vector-backfill.util';
import { isSearchVectorTriggerMode } from 'src/engine/core-modules/search-vector-trigger/utils/search-vector-trigger-maintenance.util';
import { findFlatEntityByIdInFlatEntityMaps } from 'src/engine/metadata-modules/flat-entity/utils/find-flat-entity-by-id-in-flat-entity-maps.util';
import { WorkspaceCacheService } from 'src/engine/workspace-cache/services/workspace-cache.service';
import { escapeIdentifier } from 'src/engine/workspace-manager/workspace-migration/utils/remove-sql-injection.util';
import { getWorkspaceSchemaContextForMigration } from 'src/engine/workspace-manager/workspace-migration/workspace-migration-runner/utils/get-workspace-schema-context-for-migration.util';

const SEARCH_VECTOR_BACKFILL_BATCH_SIZE = 1000;
// Below the core DataSource's 10s client query timeout, so the server cancels first.
const SEARCH_VECTOR_BACKFILL_STATEMENT_TIMEOUT = '8s';
const SEARCH_VECTOR_BACKFILL_LOCK_TIMEOUT = '2s';
const SEARCH_VECTOR_BACKFILL_LEASE_DURATION = '5 minutes';
export const SEARCH_VECTOR_BACKFILL_MAX_ATTEMPTS = 5;
const SEARCH_VECTOR_BACKFILL_RUNNING_STUCK_AFTER = '15 minutes';
// Waiting jobs only start when a slot frees up, so they get far longer before an alert.
const SEARCH_VECTOR_BACKFILL_WAITING_STUCK_AFTER = '6 hours';
// Alert once, as a job crosses the threshold; wider than the one-minute cron so a late run misses none.
const SEARCH_VECTOR_BACKFILL_STUCK_ALERT_WINDOW = '2 minutes';
const SEARCH_VECTOR_BACKFILL_COMPLETED_RETENTION = '30 days';
const SEARCH_VECTOR_BACKFILL_CLAIM_LOCK_NAME = 'search-vector-backfill-claim';

type SearchVectorBackfillJobRow = Pick<
  SearchVectorBackfillJobEntity,
  | 'id'
  | 'workspaceId'
  | 'objectMetadataId'
  | 'filter'
  | 'cursor'
  | 'status'
  | 'generation'
>;

type SearchVectorBackfillJobReference = Pick<
  SearchVectorBackfillJobRow,
  'id' | 'workspaceId' | 'objectMetadataId'
>;

export type ClaimedSearchVectorBackfillJob = {
  jobId: string;
  generation: number;
};

type BatchTarget = {
  schemaName: string;
  tableName: string;
  buildFilterSql: (addParameter: AddQueryParameter) => string;
};

type BatchResult = {
  windowRowCount: number;
  touchedRowCount: number;
  lastId: string | null;
};

const toErrorMessage = (error: unknown): string =>
  (error instanceof Error ? error.message : String(error)).slice(0, 1000);

@Injectable()
export class SearchVectorBackfillService {
  private readonly logger = new Logger(SearchVectorBackfillService.name);

  constructor(
    @InjectDataSource() private readonly dataSource: DataSource,
    private readonly workspaceCacheService: WorkspaceCacheService,
    private readonly exceptionHandlerService: ExceptionHandlerService,
  ) {}

  async claimRunnableJobs(): Promise<ClaimedSearchVectorBackfillJob[]> {
    const queryRunner = this.dataSource.createQueryRunner();

    try {
      await queryRunner.connect();
      await queryRunner.startTransaction();

      // Overlapping reconcile runs would each see the same free slots and together exceed the limits.
      const [{ isLocked }] = (await queryRunner.query(
        `SELECT pg_try_advisory_xact_lock(hashtextextended($1, 0)) AS "isLocked"`,
        [SEARCH_VECTOR_BACKFILL_CLAIM_LOCK_NAME],
      )) as Array<{ isLocked: boolean }>;

      if (!isLocked) {
        await queryRunner.rollbackTransaction();

        return [];
      }

      const activeJobs = (await queryRunner.query(
        `SELECT "id", "workspaceId", "status", "generation"
           FROM core."searchVectorBackfillJob"
          WHERE "status" IN (${ACTIVE_SEARCH_VECTOR_BACKFILL_JOB_STATUSES_SQL})
          ORDER BY "createdAt"`,
      )) as Pick<
        SearchVectorBackfillJobRow,
        'id' | 'workspaceId' | 'status' | 'generation'
      >[];

      const claimedJobs: ClaimedSearchVectorBackfillJob[] = [];

      for (const job of selectSearchVectorBackfillJobsToClaim(activeJobs)) {
        // The cutoff is taken at the start of a run, after the migration that created the job
        // committed: a cutoff taken inside it could miss rows saved by the old function meanwhile.
        const [claimedJob] = await this.updateJobs(
          `UPDATE core."searchVectorBackfillJob"
              SET "status" = 'RUNNING', "generation" = "generation" + 1,
                  "leaseExpiresAt" = now() + interval '${SEARCH_VECTOR_BACKFILL_LEASE_DURATION}',
                  "cutoffAt" = CASE WHEN "cursor" IS NULL THEN now() ELSE "cutoffAt" END,
                  "updatedAt" = now()
            WHERE "id" = $1 AND "status" = $2 AND "generation" = $3
            RETURNING "id", "generation"`,
          [job.id, job.status, job.generation],
          queryRunner,
        );

        if (isDefined(claimedJob)) {
          claimedJobs.push({
            jobId: claimedJob.id,
            generation: claimedJob.generation,
          });
        }
      }

      await queryRunner.commitTransaction();

      return claimedJobs;
    } catch (error) {
      if (queryRunner.isTransactionActive) {
        await queryRunner.rollbackTransaction();
      }

      throw error;
    } finally {
      await queryRunner.release();
    }
  }

  // Returns true when no further batch should be queued for this claim.
  async runBatch({
    jobId,
    generation,
  }: ClaimedSearchVectorBackfillJob): Promise<boolean> {
    const [job] = (await this.dataSource.query(
      `SELECT "id", "workspaceId", "objectMetadataId", "filter", "cursor", "status", "generation"
         FROM core."searchVectorBackfillJob" WHERE "id" = $1`,
      [jobId],
    )) as SearchVectorBackfillJobRow[];

    if (
      !isDefined(job) ||
      job.status !== 'RUNNING' ||
      job.generation !== generation
    ) {
      return true;
    }

    const queryRunner = this.dataSource.createQueryRunner();

    try {
      const target = await this.resolveBatchTarget(job);

      await queryRunner.connect();
      await queryRunner.startTransaction();
      await queryRunner.query(
        `SET LOCAL statement_timeout = '${SEARCH_VECTOR_BACKFILL_STATEMENT_TIMEOUT}'`,
      );
      await queryRunner.query(
        `SET LOCAL lock_timeout = '${SEARCH_VECTOR_BACKFILL_LOCK_TIMEOUT}'`,
      );

      if (
        !isDefined(target) ||
        !(await isSearchVectorTriggerMode(queryRunner, target))
      ) {
        await this.completeJob(queryRunner, job, {
          note: 'Nothing to backfill: the table is gone or no longer in trigger mode',
        });
        await queryRunner.commitTransaction();

        return true;
      }

      const batchResult = await this.touchNextRows(queryRunner, job, target);
      const isTableExhausted = batchResult.windowRowCount === 0;

      const isJobStillCurrent = isTableExhausted
        ? await this.completeJob(queryRunner, job, { note: null })
        : await this.advanceJob(queryRunner, job, batchResult);

      // A reset, reclaim or duplicate message moved the job meanwhile; its current holder redoes these rows.
      if (!isJobStillCurrent) {
        await queryRunner.rollbackTransaction();

        return true;
      }

      await queryRunner.commitTransaction();

      return isTableExhausted;
    } catch (error) {
      if (queryRunner.isTransactionActive) {
        await queryRunner.rollbackTransaction();
      }

      await this.recordFailure(job, toErrorMessage(error));

      return true;
    } finally {
      await queryRunner.release();
    }
  }

  async failExpiredLeases(): Promise<void> {
    const expiredJobs = (await this.dataSource.query(
      `SELECT "id", "workspaceId", "objectMetadataId", "generation"
         FROM core."searchVectorBackfillJob"
        WHERE "status" = 'RUNNING' AND "leaseExpiresAt" < now()`,
    )) as Pick<
      SearchVectorBackfillJobRow,
      'id' | 'workspaceId' | 'objectMetadataId' | 'generation'
    >[];

    for (const expiredJob of expiredJobs) {
      await this.recordFailure(
        expiredJob,
        'Lease expired before the batch finished',
      );
    }
  }

  // Every claim and batch bumps updatedAt, so for a running job it marks the last progress.
  async reportStuckJobs(): Promise<void> {
    const stuckJobs = (await this.dataSource.query(
      `SELECT "id", "workspaceId", "objectMetadataId", "status"
         FROM core."searchVectorBackfillJob"
        WHERE ("status" = 'RUNNING'
               AND "updatedAt" <= now() - interval '${SEARCH_VECTOR_BACKFILL_RUNNING_STUCK_AFTER}'
               AND "updatedAt" > now() - interval '${SEARCH_VECTOR_BACKFILL_RUNNING_STUCK_AFTER}'
                                       - interval '${SEARCH_VECTOR_BACKFILL_STUCK_ALERT_WINDOW}')
           OR ("status" IN ('PENDING', 'RETRYABLE')
               AND "createdAt" <= now() - interval '${SEARCH_VECTOR_BACKFILL_WAITING_STUCK_AFTER}'
               AND "createdAt" > now() - interval '${SEARCH_VECTOR_BACKFILL_WAITING_STUCK_AFTER}'
                                       - interval '${SEARCH_VECTOR_BACKFILL_STUCK_ALERT_WINDOW}')`,
    )) as Pick<
      SearchVectorBackfillJobRow,
      'id' | 'workspaceId' | 'objectMetadataId' | 'status'
    >[];

    for (const stuckJob of stuckJobs) {
      this.reportError('Search vector backfill job is stuck', stuckJob, {
        status: stuckJob.status,
      });
    }
  }

  // Failed jobs are kept until someone looks at them.
  async deleteOldCompletedJobs(): Promise<void> {
    await this.dataSource.query(
      `DELETE FROM core."searchVectorBackfillJob"
        WHERE "status" = 'COMPLETED'
          AND "completedAt" < now() - interval '${SEARCH_VECTOR_BACKFILL_COMPLETED_RETENTION}'`,
    );
  }

  // Each batch walks a fixed window of ids, so a sparse filter cannot scan most of a large table.
  // Setting id to itself fires the trigger without touching updatedAt or emitting any Twenty event.
  private async touchNextRows(
    queryRunner: QueryRunner,
    job: SearchVectorBackfillJobRow,
    { schemaName, tableName, buildFilterSql }: BatchTarget,
  ): Promise<BatchResult> {
    const qualifiedTable = `${escapeIdentifier(schemaName)}.${escapeIdentifier(tableName)}`;
    const parameters: unknown[] = [];
    const addParameter: AddQueryParameter = (value) => {
      parameters.push(value);

      return `$${parameters.length}`;
    };

    const cursorCondition = isDefined(job.cursor)
      ? `WHERE "id" > ${addParameter(job.cursor)}`
      : '';
    // Read from the job row in SQL, so the cutoff keeps its microseconds.
    const cutoffCondition = `"createdAt" <= (SELECT "cutoffAt" FROM core."searchVectorBackfillJob" WHERE "id" = ${addParameter(job.id)})`;
    const filterSql = buildFilterSql(addParameter);

    const [batchResult] = (await queryRunner.query(
      `WITH "batchWindow" AS (
         SELECT "id" FROM ${qualifiedTable} ${cursorCondition}
          ORDER BY "id" LIMIT ${SEARCH_VECTOR_BACKFILL_BATCH_SIZE}
       ),
       touched AS (
         UPDATE ${qualifiedTable} SET "id" = "id"
          WHERE "id" IN (SELECT "id" FROM "batchWindow")
            AND ${filterSql} AND ${cutoffCondition}
         RETURNING "id"
       )
       SELECT (SELECT count(*)::int FROM "batchWindow") AS "windowRowCount",
              (SELECT count(*)::int FROM touched) AS "touchedRowCount",
              (SELECT "id" FROM "batchWindow" ORDER BY "id" DESC LIMIT 1) AS "lastId"`,
      parameters,
    )) as BatchResult[];

    return batchResult;
  }

  // Column names come from the field as it is now; a field gone since means the whole table.
  private async resolveBatchTarget(
    job: SearchVectorBackfillJobRow,
  ): Promise<BatchTarget | undefined> {
    const { flatObjectMetadataMaps, flatFieldMetadataMaps } =
      await this.workspaceCacheService.getOrRecompute(job.workspaceId, [
        'flatObjectMetadataMaps',
        'flatFieldMetadataMaps',
      ]);

    const flatObjectMetadata = findFlatEntityByIdInFlatEntityMaps({
      flatEntityId: job.objectMetadataId,
      flatEntityMaps: flatObjectMetadataMaps,
    });

    if (!isDefined(flatObjectMetadata)) {
      return undefined;
    }

    const table = getWorkspaceSchemaContextForMigration({
      workspaceId: job.workspaceId,
      objectMetadata: flatObjectMetadata,
    });
    const wholeTable = { ...table, buildFilterSql: () => 'TRUE' };

    const flatFieldMetadata = isDefined(job.filter)
      ? findFlatEntityByIdInFlatEntityMaps({
          flatEntityId: job.filter.fieldMetadataId,
          flatEntityMaps: flatFieldMetadataMaps,
        })
      : undefined;

    if (
      !isDefined(job.filter) ||
      !isDefined(flatFieldMetadata) ||
      flatFieldMetadata.objectMetadataId !== job.objectMetadataId
    ) {
      return wholeTable;
    }

    return {
      ...table,
      buildFilterSql: (addParameter) =>
        buildSearchVectorBackfillFilterSql({
          flatFieldMetadata,
          optionValues: job.filter?.optionValues,
          addParameter,
        }),
    };
  }

  // Successful progress resets attempts, so only consecutive failures fail a job.
  // The cursor check stops a re-delivered message from running a second chain of batches.
  private async advanceJob(
    queryRunner: QueryRunner,
    job: SearchVectorBackfillJobRow,
    { touchedRowCount, lastId }: BatchResult,
  ): Promise<boolean> {
    const updatedJobs = await this.updateJobs(
      `UPDATE core."searchVectorBackfillJob"
          SET "cursor" = $3, "processedRowCount" = "processedRowCount" + $4,
              "attempts" = 0, "lastError" = NULL,
              "leaseExpiresAt" = now() + interval '${SEARCH_VECTOR_BACKFILL_LEASE_DURATION}',
              "updatedAt" = now()
        WHERE "id" = $1 AND "generation" = $2 AND "status" = 'RUNNING'
          AND "cursor" IS NOT DISTINCT FROM $5
        RETURNING "id"`,
      [job.id, job.generation, lastId, touchedRowCount, job.cursor],
      queryRunner,
    );

    return updatedJobs.length > 0;
  }

  private async completeJob(
    queryRunner: QueryRunner,
    job: SearchVectorBackfillJobRow,
    { note }: { note: string | null },
  ): Promise<boolean> {
    const updatedJobs = await this.updateJobs(
      `UPDATE core."searchVectorBackfillJob"
          SET "status" = 'COMPLETED', "completedAt" = now(), "leaseExpiresAt" = NULL,
              "lastError" = $3, "updatedAt" = now()
        WHERE "id" = $1 AND "generation" = $2 AND "status" = 'RUNNING'
        RETURNING "id"`,
      [job.id, job.generation, note],
      queryRunner,
    );

    return updatedJobs.length > 0;
  }

  // Guarded by generation, so a batch overtaken by a reset or reclaim records nothing.
  private async recordFailure(
    job: SearchVectorBackfillJobReference &
      Pick<SearchVectorBackfillJobRow, 'generation'>,
    errorMessage: string,
  ): Promise<void> {
    const [updatedJob] = await this.updateJobs(
      `UPDATE core."searchVectorBackfillJob"
          SET "attempts" = "attempts" + 1,
              "status" = CASE WHEN "attempts" + 1 >= $3 THEN 'FAILED' ELSE 'RETRYABLE' END,
              "lastError" = $4, "leaseExpiresAt" = NULL, "updatedAt" = now()
        WHERE "id" = $1 AND "generation" = $2 AND "status" = 'RUNNING'
        RETURNING "status"`,
      [
        job.id,
        job.generation,
        SEARCH_VECTOR_BACKFILL_MAX_ATTEMPTS,
        errorMessage,
      ],
    );

    if (updatedJob?.status === 'FAILED') {
      this.reportError('Search vector backfill job failed', job, {
        errorMessage,
      });
    } else if (isDefined(updatedJob)) {
      this.logger.warn(
        `Search vector backfill job ${job.id} failed and will be retried: ${errorMessage}`,
      );
    }
  }

  // A fixed message keeps every job in one Sentry issue; the ids go in the extra context.
  private reportError(
    message: string,
    job: SearchVectorBackfillJobReference,
    details: Record<string, string>,
  ): void {
    const context = {
      jobId: job.id,
      objectMetadataId: job.objectMetadataId,
      ...details,
    };

    this.logger.error(`${message}: ${JSON.stringify(context)}`);
    this.exceptionHandlerService.captureExceptions([new Error(message)], {
      workspace: { id: job.workspaceId },
      additionalData: context,
    });
  }

  // TypeORM returns [rows, count] for a plain UPDATE, so the structured result is read instead.
  private async updateJobs(
    sql: string,
    parameters: unknown[],
    queryRunner?: QueryRunner,
  ): Promise<Array<{ id: string; generation: number; status: string }>> {
    const runner = queryRunner ?? this.dataSource.createQueryRunner();

    try {
      const result = await runner.query(sql, parameters, true);

      return result.records;
    } finally {
      if (!isDefined(queryRunner)) {
        await runner.release();
      }
    }
  }
}
