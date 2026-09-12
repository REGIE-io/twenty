import { type EntityManager } from 'typeorm';

import { type WorkspaceDeletionMaintenanceService } from 'src/engine/workspace-manager/workspace-cleaner/services/workspace-deletion-maintenance.service';
import { WorkspaceFieldMetadataDeletionService } from 'src/engine/workspace-manager/workspace-cleaner/services/workspace-field-metadata-deletion.service';

describe('WorkspaceFieldMetadataDeletionService', () => {
  it('uses one workspace-scoped statement rather than relation-aware client chunks', async () => {
    const manager = {
      query: jest.fn().mockResolvedValue([[], 600]),
    } as unknown as EntityManager;
    const maintenance = {
      runInTransaction: jest.fn(async (_timeouts, operation) =>
        operation(manager),
      ),
    } as unknown as WorkspaceDeletionMaintenanceService;
    const service = new WorkspaceFieldMetadataDeletionService(maintenance);

    await expect(service.delete('workspace-id')).resolves.toBe(600);

    expect(manager.query).toHaveBeenCalledTimes(1);
    expect(manager.query).toHaveBeenCalledWith(
      `DELETE FROM core."fieldMetadata" WHERE "workspaceId" = $1`,
      ['workspace-id'],
    );
    expect(maintenance.runInTransaction).toHaveBeenCalledWith(
      expect.objectContaining({
        statementTimeoutMs: expect.any(Number),
        lockTimeoutMs: expect.any(Number),
      }),
      expect.any(Function),
    );
  });
});
