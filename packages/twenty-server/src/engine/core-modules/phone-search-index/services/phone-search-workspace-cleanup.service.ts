import { Injectable } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import { type DataSource } from 'typeorm';

const DELETE_BATCH_SIZE = 1_000;

@Injectable()
export class PhoneSearchWorkspaceCleanupService {
  constructor(@InjectDataSource() private readonly dataSource: DataSource) {}

  // This is deliberately invoked after the tenant schema is dropped and before
  // core.workspace is removed. The FK cascades are the final hard guarantee,
  // while batching avoids a large PII delete transaction for old workspaces.
  async cleanupWorkspace(workspaceId: string): Promise<void> {
    const [{ lookupExists, stateExists, operationExists }] =
      await this.dataSource.query<
        Array<{
          lookupExists: boolean;
          stateExists: boolean;
          operationExists: boolean;
        }>
      >(
        `SELECT to_regclass('core."personPhoneLookup"') IS NOT NULL AS "lookupExists",
                to_regclass('core."phoneSearchFieldState"') IS NOT NULL AS "stateExists",
                to_regclass('core."phoneSearchIndexOperation"') IS NOT NULL AS "operationExists"`,
      );

    if (lookupExists)
      while (true) {
        const deleted = await this.dataSource.query<Array<{ id: string }>>(
          `WITH batch AS (
           SELECT id FROM core."personPhoneLookup"
            WHERE "workspaceId" = $1
            ORDER BY id
            LIMIT ${DELETE_BATCH_SIZE}
         )
         DELETE FROM core."personPhoneLookup" lookup
          USING batch
          WHERE lookup."workspaceId" = $1 AND lookup.id = batch.id
         RETURNING lookup.id`,
          [workspaceId],
        );
        if (deleted.length < DELETE_BATCH_SIZE) break;
      }

    if (stateExists)
      await this.dataSource.query(
        `DELETE FROM core."phoneSearchFieldState" WHERE "workspaceId" = $1`,
        [workspaceId],
      );
    if (operationExists)
      await this.dataSource.query(
        `DELETE FROM core."phoneSearchIndexOperation" WHERE "workspaceId" = $1`,
        [workspaceId],
      );
  }
}
