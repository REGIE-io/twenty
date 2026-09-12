import { type DataSource, type EntityManager } from 'typeorm';

import { WorkspaceDeletionMaintenanceService } from 'src/engine/workspace-manager/workspace-cleaner/services/workspace-deletion-maintenance.service';

describe('WorkspaceDeletionMaintenanceService', () => {
  const makeService = () => {
    const manager = {} as EntityManager;
    const queryRunner = {
      manager,
      connect: jest.fn(),
      startTransaction: jest.fn(),
      query: jest.fn(),
      commitTransaction: jest.fn(),
      rollbackTransaction: jest.fn(),
      release: jest.fn(),
    };
    const dataSource = {
      createQueryRunner: jest.fn(() => queryRunner),
    } as unknown as DataSource;

    return {
      manager,
      queryRunner,
      service: new WorkspaceDeletionMaintenanceService(dataSource),
    };
  };

  it('sets server-side statement and lock deadlines inside the phase transaction', async () => {
    const { manager, queryRunner, service } = makeService();
    const operation = jest.fn().mockResolvedValue('done');

    await expect(
      service.runInTransaction(
        { statementTimeoutMs: 5_000, lockTimeoutMs: 100 },
        operation,
      ),
    ).resolves.toBe('done');

    expect(queryRunner.query).toHaveBeenNthCalledWith(
      1,
      `SELECT set_config('statement_timeout', $1, true)`,
      ['5000ms'],
    );
    expect(queryRunner.query).toHaveBeenNthCalledWith(
      2,
      `SELECT set_config('lock_timeout', $1, true)`,
      ['100ms'],
    );
    expect(operation).toHaveBeenCalledWith(manager);
    expect(queryRunner.commitTransaction).toHaveBeenCalledTimes(1);
    expect(queryRunner.release).toHaveBeenCalledTimes(1);
  });

  it('rolls back and releases when PostgreSQL cancels a maintenance statement', async () => {
    const { queryRunner, service } = makeService();
    const timeout = Object.assign(
      new Error('canceling statement due to lock timeout'),
      {
        code: '55P03',
      },
    );

    await expect(
      service.runInTransaction(
        { statementTimeoutMs: 5_000, lockTimeoutMs: 100 },
        async () => {
          throw timeout;
        },
      ),
    ).rejects.toBe(timeout);

    expect(queryRunner.rollbackTransaction).toHaveBeenCalledTimes(1);
    expect(queryRunner.commitTransaction).not.toHaveBeenCalled();
    expect(queryRunner.release).toHaveBeenCalledTimes(1);
  });
});
