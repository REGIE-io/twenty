import { Injectable, ServiceUnavailableException } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import { type DataSource, type EntityManager } from 'typeorm';

@Injectable()
export class PhoneSearchMetadataGateService {
  constructor(@InjectDataSource() private readonly dataSource: DataSource) {}

  async assertAvailable({
    workspaceId,
    objectMetadataId,
    operationId,
    generation,
    manager,
  }: {
    workspaceId: string;
    objectMetadataId: string;
    operationId?: string;
    generation?: number;
    manager?: EntityManager;
  }): Promise<void> {
    const queryable = manager ?? this.dataSource;
    // Cross-version upgrades instantiate current modules while replaying older
    // workspace commands. Until the 2.32 instance command owns these tables,
    // phone-search lifecycle gating is intentionally unavailable (and must not
    // block an unrelated historical migration).
    if (!(await this.isInfrastructureAvailable(manager))) return;
    // This lock is scoped to the caller's migration transaction. It serializes
    // the check with the later state/DDL writes and is released at commit or
    // rollback, never while a background index job is running.
    await queryable.query(
      `SELECT pg_advisory_xact_lock(hashtextextended($1::text || ':' || $2::text, 0))`,
      [workspaceId, objectMetadataId],
    );
    const rows = await queryable.query<
      Array<{
        id: string;
        status: string;
        kind: string;
        generation: string;
        processedRecordCount: string;
      }>
    >(
      `SELECT id, status, kind, generation, "processedRecordCount" FROM core."phoneSearchIndexOperation" WHERE "workspaceId" = $1 AND "objectMetadataId" = $2 AND status IN ('PENDING','RUNNING','RETRYABLE','FAILED') ORDER BY "createdAt" ASC LIMIT 1`,
      [workspaceId, objectMetadataId],
    );
    const operation = rows[0];
    if (!operation) return;
    if (
      operationId === operation.id &&
      generation === Number(operation.generation)
    )
      return;
    throw new ServiceUnavailableException({
      code: 'PHONE_SEARCH_METADATA_BUSY',
      operationId: operation.id,
      status: operation.status,
      kind: operation.kind,
      processedRecordCount: Number(operation.processedRecordCount),
      retryAfter: 5,
    });
  }

  async isInfrastructureAvailable(manager?: EntityManager): Promise<boolean> {
    const queryable = manager ?? this.dataSource;
    const [{ isAvailable }] = await queryable.query<
      Array<{ isAvailable: boolean }>
    >(
      `SELECT to_regclass('core."phoneSearchIndexOperation"') IS NOT NULL AS "isAvailable"`,
    );

    return isAvailable;
  }
}
