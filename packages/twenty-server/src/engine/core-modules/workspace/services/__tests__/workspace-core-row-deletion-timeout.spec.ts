import { type EntityManager } from 'typeorm';

import { WorkspaceService } from 'src/engine/core-modules/workspace/services/workspace.service';
import { WorkspaceEntity } from 'src/engine/core-modules/workspace/workspace.entity';

describe('WorkspaceService final core-row deletion deadline', () => {
  it('uses the bounded maintenance transaction so a client timeout cannot leave an ambiguous commit', async () => {
    const manager = { delete: jest.fn().mockResolvedValue({ affected: 1 }) };
    const maintenance = {
      runInTransaction: jest.fn(async (_timeouts, operation) =>
        operation(manager as unknown as EntityManager),
      ),
    };
    const repository = { delete: jest.fn() };
    const cache = { invalidate: jest.fn() };
    const service = Object.create(
      WorkspaceService.prototype,
    ) as WorkspaceService;

    Reflect.set(service, 'workspaceDeletionMaintenanceService', maintenance);
    Reflect.set(service, 'workspaceRepository', repository);
    Reflect.set(service, 'coreEntityCacheService', cache);
    Reflect.set(service, 'logger', { log: jest.fn() });

    await service.hardDeleteWorkspaceCoreRow(
      '20202020-0000-4000-8000-000000000001',
    );

    expect(maintenance.runInTransaction).toHaveBeenCalledWith(
      {
        statementTimeoutMs: expect.any(Number),
        lockTimeoutMs: expect.any(Number),
        clientTimeoutMs: expect.any(Number),
      },
      expect.any(Function),
    );
    const timeouts = maintenance.runInTransaction.mock.calls[0][0];

    expect(timeouts.lockTimeoutMs).toBeLessThan(timeouts.statementTimeoutMs);
    expect(timeouts.statementTimeoutMs).toBeLessThan(timeouts.clientTimeoutMs);
    expect(manager.delete).toHaveBeenCalledWith(WorkspaceEntity, {
      id: '20202020-0000-4000-8000-000000000001',
    });
    expect(repository.delete).not.toHaveBeenCalled();
    expect(cache.invalidate).toHaveBeenCalledWith(
      'workspaceEntity',
      '20202020-0000-4000-8000-000000000001',
    );
  });
});
