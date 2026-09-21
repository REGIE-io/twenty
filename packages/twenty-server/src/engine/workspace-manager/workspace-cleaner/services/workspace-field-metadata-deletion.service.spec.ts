import { type DataSource, type EntityManager } from 'typeorm';

import { type WorkspaceDeletionMaintenanceService } from 'src/engine/workspace-manager/workspace-cleaner/services/workspace-deletion-maintenance.service';
import { WorkspaceFieldMetadataDeletionService } from 'src/engine/workspace-manager/workspace-cleaner/services/workspace-field-metadata-deletion.service';

const id = (value: number) =>
  `00000000-0000-4000-8000-${value.toString().padStart(12, '0')}`;

describe('WorkspaceFieldMetadataDeletionService', () => {
  it('derives bounded relation-safe batches from PostgreSQL rather than cache state', async () => {
    const relationLeft = id(50);
    const relationRight = id(51);
    const rows = Array.from({ length: 103 }, (_, index) => ({
      id: id(index + 1),
      relationTargetFieldMetadataId:
        index === 49 ? relationRight : index === 50 ? relationLeft : null,
    }));
    const dataSource = {
      query: jest.fn().mockResolvedValue(rows),
    } as unknown as DataSource;
    const manager = {
      query: jest.fn(async (_sql, [, ids]) => [[], ids.length]),
    } as unknown as EntityManager;
    const maintenance = {
      runInTransaction: jest.fn(async (_timeouts, operation) =>
        operation(manager),
      ),
    } as unknown as WorkspaceDeletionMaintenanceService;
    const service = new WorkspaceFieldMetadataDeletionService(
      dataSource,
      maintenance,
    );

    await expect(service.delete('workspace-id')).resolves.toBe(103);

    expect(dataSource.query).toHaveBeenCalledWith(
      expect.stringContaining('relationTargetFieldMetadataId'),
      ['workspace-id'],
    );
    const batches = (manager.query as jest.Mock).mock.calls.map(
      ([, parameters]) => parameters[1] as string[],
    );

    expect(batches.every((batch) => batch.length <= 50)).toBe(true);
    expect(
      batches.some(
        (batch) =>
          batch.includes(relationLeft) && batch.includes(relationRight),
      ),
    ).toBe(true);
    expect(maintenance.runInTransaction).toHaveBeenCalledTimes(3);
  });

  it('commits completed batches and resumes from database state after failure', async () => {
    const allRows = Array.from({ length: 75 }, (_, index) => ({
      id: id(index + 1),
      relationTargetFieldMetadataId: null,
    }));
    const dataSource = {
      query: jest
        .fn()
        .mockResolvedValueOnce(allRows)
        .mockResolvedValueOnce(allRows.slice(50)),
    } as unknown as DataSource;
    const manager = {
      query: jest
        .fn()
        .mockResolvedValueOnce([[], 50])
        .mockRejectedValueOnce(new Error('statement timeout'))
        .mockResolvedValueOnce([[], 25]),
    } as unknown as EntityManager;
    const maintenance = {
      runInTransaction: jest.fn(async (_timeouts, operation) =>
        operation(manager),
      ),
    } as unknown as WorkspaceDeletionMaintenanceService;
    const service = new WorkspaceFieldMetadataDeletionService(
      dataSource,
      maintenance,
    );

    await expect(service.delete('workspace-id')).rejects.toThrow(
      'statement timeout',
    );
    await expect(service.delete('workspace-id')).resolves.toBe(25);

    expect(dataSource.query).toHaveBeenCalledTimes(2);
    expect(maintenance.runInTransaction).toHaveBeenCalledTimes(3);
  });
});
