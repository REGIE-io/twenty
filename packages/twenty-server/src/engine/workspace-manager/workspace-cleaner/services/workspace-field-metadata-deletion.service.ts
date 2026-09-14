import { Injectable } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';

import { DataSource } from 'typeorm';

import {
  WORKSPACE_DELETION_CLIENT_TIMEOUT_MS,
  WORKSPACE_DELETION_LOCK_TIMEOUT_MS,
  WORKSPACE_DELETION_STATEMENT_TIMEOUT_MS,
} from 'src/engine/workspace-manager/workspace-cleaner/constants/workspace-deletion-timeouts.constant';
import { WorkspaceDeletionMaintenanceService } from 'src/engine/workspace-manager/workspace-cleaner/services/workspace-deletion-maintenance.service';

const FIELD_METADATA_DELETE_BATCH_SIZE = 50;

type FieldRelationRow = {
  id: string;
  relationTargetFieldMetadataId: string | null;
};

@Injectable()
export class WorkspaceFieldMetadataDeletionService {
  constructor(
    @InjectDataSource()
    private readonly coreDataSource: DataSource,
    private readonly maintenance: WorkspaceDeletionMaintenanceService,
  ) {}

  async delete(workspaceId: string): Promise<number> {
    const rows = (await this.coreDataSource.query(
      `SELECT "id", "relationTargetFieldMetadataId"
       FROM core."fieldMetadata"
       WHERE "workspaceId" = $1
       ORDER BY "id"`,
      [workspaceId],
    )) as FieldRelationRow[];
    const batches = this.buildRelationSafeBatches(rows);
    let totalDeleted = 0;

    // Each relation-safe batch commits independently. A retry therefore reads
    // only rows that remain after the last committed batch and resumes there.
    for (const ids of batches) {
      totalDeleted += await this.maintenance.runInTransaction(
        {
          statementTimeoutMs: WORKSPACE_DELETION_STATEMENT_TIMEOUT_MS,
          lockTimeoutMs: WORKSPACE_DELETION_LOCK_TIMEOUT_MS,
          clientTimeoutMs: WORKSPACE_DELETION_CLIENT_TIMEOUT_MS,
        },
        async (manager) => {
          const result = await manager.query(
            `DELETE FROM core."fieldMetadata"
             WHERE "workspaceId" = $1 AND "id" = ANY($2::uuid[])`,
            [workspaceId, ids],
          );

          if (Array.isArray(result) && typeof result[1] === 'number') {
            return result[1];
          }

          return typeof result?.rowCount === 'number' ? result.rowCount : 0;
        },
      );
    }

    return totalDeleted;
  }

  private buildRelationSafeBatches(rows: FieldRelationRow[]): string[][] {
    const knownIds = new Set(rows.map(({ id }) => id));
    const neighbors = new Map<string, Set<string>>(
      rows.map(({ id }) => [id, new Set<string>()]),
    );

    for (const { id, relationTargetFieldMetadataId: targetId } of rows) {
      if (targetId && knownIds.has(targetId)) {
        neighbors.get(id)?.add(targetId);
        neighbors.get(targetId)?.add(id);
      }
    }

    const components: string[][] = [];
    const visited = new Set<string>();

    for (const { id } of rows) {
      if (visited.has(id)) {
        continue;
      }
      const component: string[] = [];
      const pending = [id];

      while (pending.length > 0) {
        const currentId = pending.pop();

        if (!currentId || visited.has(currentId)) {
          continue;
        }
        visited.add(currentId);
        component.push(currentId);
        pending.push(...(neighbors.get(currentId) ?? []));
      }
      components.push(component);
    }

    const batches: string[][] = [];
    let batch: string[] = [];

    for (const component of components) {
      if (
        batch.length > 0 &&
        batch.length + component.length > FIELD_METADATA_DELETE_BATCH_SIZE
      ) {
        batches.push(batch);
        batch = [];
      }
      batch.push(...component);

      if (batch.length >= FIELD_METADATA_DELETE_BATCH_SIZE) {
        batches.push(batch);
        batch = [];
      }
    }
    if (batch.length > 0) {
      batches.push(batch);
    }

    return batches;
  }
}
