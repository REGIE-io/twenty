import { Injectable } from '@nestjs/common';

import { type EntityManager } from 'typeorm';

import { WorkspaceDeletionMaintenanceService } from 'src/engine/workspace-manager/workspace-cleaner/services/workspace-deletion-maintenance.service';

const METADATA_STATEMENT_TIMEOUT_MS = 60_000;
const METADATA_LOCK_TIMEOUT_MS = 2_000;

@Injectable()
export class WorkspaceFieldMetadataDeletionService {
  constructor(
    private readonly maintenance: WorkspaceDeletionMaintenanceService,
  ) {}

  delete(workspaceId: string): Promise<number> {
    return this.maintenance.runInTransaction(
      {
        statementTimeoutMs: METADATA_STATEMENT_TIMEOUT_MS,
        lockTimeoutMs: METADATA_LOCK_TIMEOUT_MS,
      },
      (manager) => this.deleteWithManager(manager, workspaceId),
    );
  }

  async deleteWithManager(
    manager: EntityManager,
    workspaceId: string,
  ): Promise<number> {
    const result = await manager.query(
      `DELETE FROM core."fieldMetadata" WHERE "workspaceId" = $1`,
      [workspaceId],
    );

    if (Array.isArray(result) && typeof result[1] === 'number') {
      return result[1];
    }

    return typeof result?.rowCount === 'number' ? result.rowCount : 0;
  }
}
