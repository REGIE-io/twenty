import { Injectable } from '@nestjs/common';

import { type EntityManager } from 'typeorm';

import {
  WORKSPACE_DELETION_CLIENT_TIMEOUT_MS,
  WORKSPACE_DELETION_LOCK_TIMEOUT_MS,
  WORKSPACE_DELETION_STATEMENT_TIMEOUT_MS,
} from 'src/engine/workspace-manager/workspace-cleaner/constants/workspace-deletion-timeouts.constant';
import { WorkspaceDeletionMaintenanceService } from 'src/engine/workspace-manager/workspace-cleaner/services/workspace-deletion-maintenance.service';

@Injectable()
export class WorkspaceFieldMetadataDeletionService {
  constructor(
    private readonly maintenance: WorkspaceDeletionMaintenanceService,
  ) {}

  delete(workspaceId: string): Promise<number> {
    return this.maintenance.runInTransaction(
      {
        statementTimeoutMs: WORKSPACE_DELETION_STATEMENT_TIMEOUT_MS,
        lockTimeoutMs: WORKSPACE_DELETION_LOCK_TIMEOUT_MS,
        clientTimeoutMs: WORKSPACE_DELETION_CLIENT_TIMEOUT_MS,
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
