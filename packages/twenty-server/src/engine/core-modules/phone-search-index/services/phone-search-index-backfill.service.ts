import { Injectable, Logger } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import { type DataSource } from 'typeorm';

import { InjectMessageQueue } from 'src/engine/core-modules/message-queue/decorators/message-queue.decorator';
import { MessageQueue } from 'src/engine/core-modules/message-queue/message-queue.constants';
import { MessageQueueService } from 'src/engine/core-modules/message-queue/services/message-queue.service';
import { getWorkspaceSchemaName } from 'src/engine/workspace-datasource/utils/get-workspace-schema-name.util';
import { TwentyConfigService } from 'src/engine/core-modules/twenty-config/twenty-config.service';

const BATCH_SIZE = 250;
export const PHONE_SEARCH_INDEX_MAX_CONSECUTIVE_FAILURES = 5;

type PhoneSearchIndexOperation = {
  workspaceId: string;
  objectMetadataId: string;
  generation: string;
  lastRecordId: string | null;
  status: string;
  kind: string;
  fieldMetadataIds: string[];
  leaseExpiresAt: Date | null;
};

@Injectable()
export class PhoneSearchIndexBackfillService {
  private readonly logger = new Logger(PhoneSearchIndexBackfillService.name);
  private readonly statementTimeoutMs: number;

  constructor(
    @InjectDataSource() private readonly dataSource: DataSource,
    @InjectMessageQueue(MessageQueue.phoneSearchIndexQueue)
    private readonly queue: MessageQueueService,
    twentyConfigService: TwentyConfigService,
  ) {
    const statementTimeoutMs = twentyConfigService.get(
      'PHONE_SEARCH_INDEX_BATCH_STATEMENT_TIMEOUT_MS',
    );

    if (!Number.isSafeInteger(statementTimeoutMs) || statementTimeoutMs <= 0) {
      throw new Error(
        'PHONE_SEARCH_INDEX_BATCH_STATEMENT_TIMEOUT_MS must be a positive safe integer',
      );
    }
    this.statementTimeoutMs = statementTimeoutMs;
  }

  // Each call owns one short transaction. Retrying a cursor is safe because a
  // row/generation refresh deletes its old projection before inserting values.
  async runBatch(operationId: string): Promise<boolean> {
    const runner = this.dataSource.createQueryRunner();
    let claimedOperation: PhoneSearchIndexOperation | undefined;

    try {
      await runner.connect();
      await runner.startTransaction();
      await runner.query("SET LOCAL lock_timeout = '2s'");
      await runner.query(
        `SET LOCAL statement_timeout = '${this.statementTimeoutMs}ms'`,
      );
      const [operation] = (await runner.query(
        `SELECT * FROM core."phoneSearchIndexOperation" WHERE id = $1 FOR UPDATE`,
        [operationId],
      )) as PhoneSearchIndexOperation[];
      if (
        !operation ||
        !['PENDING', 'RUNNING', 'RETRYABLE'].includes(operation.status)
      ) {
        await runner.commitTransaction();
        return true;
      }
      if (operation.leaseExpiresAt && operation.leaseExpiresAt > new Date()) {
        await runner.commitTransaction();
        return false;
      }
      claimedOperation = operation;
      await runner.query(
        `UPDATE core."phoneSearchIndexOperation" SET status = 'RUNNING', "leaseOwner" = $2, "leaseExpiresAt" = now() + interval '2 minutes', "heartbeatAt" = now() WHERE id = $1`,
        [operationId, `worker:${process.pid}`],
      );
      if (
        operation.kind === 'PURGE_FIELD' ||
        operation.kind === 'PURGE_GENERATION'
      ) {
        const purgePredicate =
          operation.kind === 'PURGE_GENERATION'
            ? `AND NOT EXISTS (
                 SELECT 1
                   FROM core."phoneSearchFieldState" state
                  WHERE state."workspaceId" = lookup."workspaceId"
                    AND state."objectMetadataId" = lookup."objectMetadataId"
                    AND state."fieldMetadataId" = lookup."fieldMetadataId"
                    AND state."activeProjectionGeneration" = lookup."projectionGeneration"
               )`
            : 'AND lookup."fieldMetadataId" = ANY($3::uuid[])';
        const purgeParameters = [
          operation.workspaceId,
          operation.objectMetadataId,
          ...(operation.kind === 'PURGE_FIELD'
            ? [operation.fieldMetadataIds]
            : []),
        ];

        await runner.query(
          `WITH batch AS (
             SELECT lookup.id
               FROM core."personPhoneLookup" lookup
              WHERE lookup."workspaceId" = $1
                AND lookup."objectMetadataId" = $2
                ${purgePredicate}
              LIMIT ${BATCH_SIZE}
           )
           DELETE FROM core."personPhoneLookup" lookup
            WHERE lookup."workspaceId" = $1
              AND lookup."objectMetadataId" = $2
              AND lookup.id IN (SELECT id FROM batch)
           RETURNING lookup.id`,
          purgeParameters,
        );
        const [remaining] = (await runner.query(
          `SELECT EXISTS (
             SELECT 1 FROM core."personPhoneLookup" lookup
              WHERE lookup."workspaceId" = $1
                AND lookup."objectMetadataId" = $2
                ${purgePredicate}
           ) AS exists`,
          purgeParameters,
        )) as Array<{ exists: boolean }>;
        if (!remaining?.exists) {
          if (operation.kind === 'PURGE_FIELD')
            await runner.query(
              `DELETE FROM core."phoneSearchFieldState" WHERE "workspaceId" = $1 AND "objectMetadataId" = $2 AND "fieldMetadataId" = ANY($3::uuid[]) AND "syncStatus" = 'DELETING'`,
              [
                operation.workspaceId,
                operation.objectMetadataId,
                operation.fieldMetadataIds,
              ],
            );
          await runner.query(
            `UPDATE core."phoneSearchIndexOperation" SET status = 'COMPLETED', "attemptCount" = 0, "lastError" = NULL, "lastErrorAt" = NULL, "leaseOwner" = NULL, "leaseExpiresAt" = NULL, "heartbeatAt" = NULL, "completedAt" = now(), "updatedAt" = now() WHERE id = $1`,
            [operationId],
          );
        } else {
          // The queue deliberately schedules another delivery for incomplete
          // work. Release this short lease before committing so that delivery
          // can make progress immediately instead of waiting two minutes.
          await runner.query(
            `UPDATE core."phoneSearchIndexOperation" SET status = 'PENDING', "attemptCount" = 0, "lastError" = NULL, "lastErrorAt" = NULL, "leaseOwner" = NULL, "leaseExpiresAt" = NULL, "heartbeatAt" = NULL, "updatedAt" = now() WHERE id = $1`,
            [operationId],
          );
        }
        await runner.commitTransaction();
        return !remaining?.exists;
      }
      const schema = getWorkspaceSchemaName(operation.workspaceId);
      const records = (await runner.query(
        `SELECT p.id, to_jsonb(p) AS row FROM "${schema}"."person" p WHERE p.id > COALESCE($1::uuid, '00000000-0000-0000-0000-000000000000'::uuid) ORDER BY p.id LIMIT ${BATCH_SIZE} FOR UPDATE`,
        [operation.lastRecordId],
      )) as Array<{ id: string; row: Record<string, unknown> }>;
      const states = (await runner.query(
        `SELECT "fieldMetadataId", "physicalFieldName", "buildingProjectionGeneration" FROM core."phoneSearchFieldState" WHERE "workspaceId" = $1 AND "objectMetadataId" = $2 AND "buildingProjectionGeneration" = $3`,
        [
          operation.workspaceId,
          operation.objectMetadataId,
          operation.generation,
        ],
      )) as Array<{
        fieldMetadataId: string;
        physicalFieldName: string;
        buildingProjectionGeneration: string | null;
      }>;
      for (const record of records)
        for (const state of states) {
          await runner.query(
            `DELETE FROM core."personPhoneLookup" WHERE "workspaceId" = $1 AND "objectMetadataId" = $2 AND "fieldMetadataId" = $3 AND "recordId" = $4 AND "projectionGeneration" = $5`,
            [
              operation.workspaceId,
              operation.objectMetadataId,
              state.fieldMetadataId,
              record.id,
              operation.generation,
            ],
          );
          await runner.query(
            `INSERT INTO core."personPhoneLookup" ("workspaceId", "objectMetadataId", "fieldMetadataId", "recordId", "projectionGeneration", "canonicalPhone") SELECT $1, $2, $3, $4, $5, "canonicalPhone" FROM public.phone_search_values($6::jsonb, $7) ON CONFLICT DO NOTHING`,
            [
              operation.workspaceId,
              operation.objectMetadataId,
              state.fieldMetadataId,
              record.id,
              operation.generation,
              JSON.stringify(record.row),
              state.physicalFieldName,
            ],
          );
        }
      const lastId = records[records.length - 1]?.id;
      if (lastId)
        await runner.query(
          // The next delivery is deliberately queued only after this commit.
          // Release our lease here; otherwise it sees the lease we just set and
          // keeps re-enqueueing without doing the next batch for two minutes.
          `UPDATE core."phoneSearchIndexOperation" SET status = 'PENDING', "lastRecordId" = $2, "processedRecordCount" = "processedRecordCount" + $3, "attemptCount" = 0, "lastError" = NULL, "lastErrorAt" = NULL, "leaseOwner" = NULL, "leaseExpiresAt" = NULL, "heartbeatAt" = NULL, "updatedAt" = now() WHERE id = $1`,
          [operationId, lastId, records.length],
        );
      let purgeOperationId: string | undefined;
      if (records.length < BATCH_SIZE) {
        await runner.query(
          `UPDATE core."phoneSearchFieldState" SET "activeProjectionGeneration" = "buildingProjectionGeneration", "buildingProjectionGeneration" = NULL, "syncStatus" = 'READY', "updatedAt" = now() WHERE "workspaceId" = $1 AND "objectMetadataId" = $2 AND "buildingProjectionGeneration" = $3`,
          [
            operation.workspaceId,
            operation.objectMetadataId,
            operation.generation,
          ],
        );
        await runner.query(
          `UPDATE core."phoneSearchIndexOperation" SET status = 'COMPLETED', "attemptCount" = 0, "lastError" = NULL, "lastErrorAt" = NULL, "leaseOwner" = NULL, "leaseExpiresAt" = NULL, "heartbeatAt" = NULL, "completedAt" = now(), "updatedAt" = now() WHERE id = $1`,
          [operationId],
        );
        const [purgeOperation] = (await runner.query(
          `INSERT INTO core."phoneSearchIndexOperation" ("workspaceId","objectMetadataId",kind,status,generation,"fieldMetadataIds")
           VALUES ($1,$2,'PURGE_GENERATION','PENDING',$3,$4::jsonb)
           ON CONFLICT DO NOTHING RETURNING id`,
          [
            operation.workspaceId,
            operation.objectMetadataId,
            operation.generation,
            JSON.stringify(operation.fieldMetadataIds),
          ],
        )) as Array<{ id: string }>;
        purgeOperationId = purgeOperation?.id;
      }
      await runner.commitTransaction();
      if (purgeOperationId) await this.enqueueBestEffort(purgeOperationId);
      return records.length < BATCH_SIZE;
    } catch (error) {
      if (runner.isTransactionActive) await runner.rollbackTransaction();
      if (claimedOperation) {
        try {
          const cleanupOperationId = await this.recordFailure(
            operationId,
            claimedOperation,
            error,
          );

          if (cleanupOperationId)
            await this.enqueueBestEffort(cleanupOperationId);
        } catch (bookkeepingError) {
          this.logger.error(
            `Failed to persist phone-search failure for ${operationId}: ${String(bookkeepingError)}`,
          );
        }
      }
      throw error;
    } finally {
      await runner.release();
    }
  }

  private async recordFailure(
    operationId: string,
    operation: PhoneSearchIndexOperation,
    error: unknown,
  ): Promise<string | undefined> {
    const lastError = (error instanceof Error ? error.message : String(error))
      .replace(/[\u0000-\u001F\u007F]+/g, ' ')
      .trim()
      .slice(0, 1000);

    return this.dataSource.transaction(async (manager) => {
      const [failedOperation] = await manager.query<Array<{ status: string }>>(
        `UPDATE core."phoneSearchIndexOperation"
            SET "attemptCount" = "attemptCount" + 1,
                status = CASE WHEN "attemptCount" + 1 >= $2 THEN 'FAILED' ELSE 'RETRYABLE' END,
                "lastError" = $3,
                "lastErrorAt" = now(),
                "leaseOwner" = NULL,
                "leaseExpiresAt" = NULL,
                "heartbeatAt" = NULL,
                "updatedAt" = now()
          WHERE id = $1 AND status IN ('PENDING','RUNNING','RETRYABLE')
          RETURNING status`,
        [
          operationId,
          PHONE_SEARCH_INDEX_MAX_CONSECUTIVE_FAILURES,
          lastError || 'Unknown phone-search backfill error',
        ],
      );

      if (failedOperation?.status !== 'FAILED') return undefined;

      await manager.query(
        `UPDATE core."phoneSearchFieldState"
            SET "syncStatus" = 'FAILED',
                "buildingProjectionGeneration" = NULL,
                "lastError" = $4,
                "lastErrorAt" = now(),
                "updatedAt" = now()
          WHERE "workspaceId" = $1
            AND "objectMetadataId" = $2
            AND "buildingProjectionGeneration" = $3`,
        [
          operation.workspaceId,
          operation.objectMetadataId,
          operation.generation,
          lastError || 'Unknown phone-search backfill error',
        ],
      );

      if (
        operation.kind === 'PURGE_FIELD' ||
        operation.kind === 'PURGE_GENERATION'
      ) {
        return undefined;
      }

      const [cleanupOperation] = await manager.query<Array<{ id: string }>>(
        `INSERT INTO core."phoneSearchIndexOperation" ("workspaceId","objectMetadataId",kind,status,generation,"fieldMetadataIds")
         VALUES ($1,$2,'PURGE_GENERATION','PENDING',$3,$4::jsonb)
         ON CONFLICT DO NOTHING RETURNING id`,
        [
          operation.workspaceId,
          operation.objectMetadataId,
          operation.generation,
          JSON.stringify(operation.fieldMetadataIds),
        ],
      );

      return cleanupOperation?.id;
    });
  }

  private async enqueueBestEffort(operationId: string): Promise<void> {
    try {
      await this.queue.add('PhoneSearchIndexJob', { operationId });
    } catch (error) {
      this.logger.warn(
        `Failed to enqueue durable phone-search operation ${operationId}; the reconciler will retry: ${String(error)}`,
      );
    }
  }
}
