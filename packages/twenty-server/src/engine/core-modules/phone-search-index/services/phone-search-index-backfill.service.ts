import { Injectable } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import { type DataSource } from 'typeorm';

import { InjectMessageQueue } from 'src/engine/core-modules/message-queue/decorators/message-queue.decorator';
import { MessageQueue } from 'src/engine/core-modules/message-queue/message-queue.constants';
import { MessageQueueService } from 'src/engine/core-modules/message-queue/services/message-queue.service';
import { getWorkspaceSchemaName } from 'src/engine/workspace-datasource/utils/get-workspace-schema-name.util';

const BATCH_SIZE = 250;

@Injectable()
export class PhoneSearchIndexBackfillService {
  constructor(
    @InjectDataSource() private readonly dataSource: DataSource,
    @InjectMessageQueue(MessageQueue.phoneSearchIndexQueue)
    private readonly queue: MessageQueueService,
  ) {}

  // Each call owns one short transaction. Retrying a cursor is safe because a
  // row/generation refresh deletes its old projection before inserting values.
  async runBatch(operationId: string): Promise<boolean> {
    const runner = this.dataSource.createQueryRunner();
    try {
      await runner.connect();
      await runner.startTransaction();
      await runner.query("SET LOCAL lock_timeout = '2s'");
      const [operation] = (await runner.query(
        `SELECT * FROM core."phoneSearchIndexOperation" WHERE id = $1 FOR UPDATE`,
        [operationId],
      )) as Array<{
        workspaceId: string;
        objectMetadataId: string;
        generation: string;
        lastRecordId: string | null;
        status: string;
        kind: string;
        fieldMetadataIds: string[];
        leaseExpiresAt: Date | null;
      }>;
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
      await runner.query(
        `UPDATE core."phoneSearchIndexOperation" SET status = 'RUNNING', "leaseOwner" = $2, "leaseExpiresAt" = now() + interval '2 minutes', "heartbeatAt" = now(), "attemptCount" = "attemptCount" + 1 WHERE id = $1`,
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
            `UPDATE core."phoneSearchIndexOperation" SET status = 'COMPLETED', "completedAt" = now(), "updatedAt" = now() WHERE id = $1`,
            [operationId],
          );
        } else {
          // The queue deliberately schedules another delivery for incomplete
          // work. Release this short lease before committing so that delivery
          // can make progress immediately instead of waiting two minutes.
          await runner.query(
            `UPDATE core."phoneSearchIndexOperation" SET status = 'PENDING', "leaseOwner" = NULL, "leaseExpiresAt" = NULL, "heartbeatAt" = NULL, "updatedAt" = now() WHERE id = $1`,
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
          `UPDATE core."phoneSearchIndexOperation" SET status = 'PENDING', "lastRecordId" = $2, "processedRecordCount" = "processedRecordCount" + $3, "leaseOwner" = NULL, "leaseExpiresAt" = NULL, "heartbeatAt" = NULL, "updatedAt" = now() WHERE id = $1`,
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
          `UPDATE core."phoneSearchIndexOperation" SET status = 'COMPLETED', "completedAt" = now(), "updatedAt" = now() WHERE id = $1`,
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
      if (purgeOperationId)
        await this.queue.add('PhoneSearchIndexJob', {
          operationId: purgeOperationId,
        });
      return records.length < BATCH_SIZE;
    } catch (error) {
      if (runner.isTransactionActive) await runner.rollbackTransaction();
      throw error;
    } finally {
      await runner.release();
    }
  }
}
