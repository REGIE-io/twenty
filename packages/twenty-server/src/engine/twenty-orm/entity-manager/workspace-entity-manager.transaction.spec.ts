import { DataSource, EntitySchema, type QueryRunner } from 'typeorm';
import { ConnectionMetadataBuilder } from 'typeorm/connection/ConnectionMetadataBuilder';

import { type FeatureFlagMap } from 'src/engine/core-modules/feature-flag/interfaces/feature-flag-map.interface';
import { type WorkspaceInternalContext } from 'src/engine/twenty-orm/interfaces/workspace-internal-context.interface';

import { type WorkspaceAuthContext } from 'src/engine/core-modules/auth/types/workspace-auth-context.type';
import { WorkspaceEntityManager } from 'src/engine/twenty-orm/entity-manager/workspace-entity-manager';
import { GlobalWorkspaceDataSource } from 'src/engine/twenty-orm/global-workspace-datasource/global-workspace-datasource';
import { WorkspaceUpdateQueryBuilder } from 'src/engine/twenty-orm/repository/workspace-update-query-builder';
import { type WorkspaceEventEmitter } from 'src/engine/workspace-event-emitter/workspace-event-emitter';

const createManager = async (queryRunner?: QueryRunner) => {
  // Real TypeORM builders retain their runner when converted to workspace builders.
  const coreDataSource = new DataSource({ type: 'postgres' });
  const dataSource = new GlobalWorkspaceDataSource(
    { type: 'postgres' },
    {} as WorkspaceEventEmitter,
    coreDataSource,
  );
  const [metadata] = await new ConnectionMetadataBuilder(
    coreDataSource,
  ).buildEntityMetadatas([
    new EntitySchema({
      name: 'workspaceMember',
      columns: {
        id: { type: String, primary: true },
        userEmail: { type: String },
      },
    }),
  ]);

  jest
    .spyOn(dataSource, 'findMetadata')
    .mockImplementation((target) =>
      target === metadata.target ? metadata : undefined,
    );

  const manager = new WorkspaceEntityManager(dataSource, queryRunner);

  jest.spyOn(manager, 'internalContext', 'get').mockReturnValue({
    objectIdByNameSingular: {},
  } as WorkspaceInternalContext);
  jest
    .spyOn(manager, 'authContext', 'get')
    .mockReturnValue({} as WorkspaceAuthContext);
  jest
    .spyOn(manager, 'getFeatureFlagMap')
    .mockReturnValue({} as FeatureFlagMap);

  return manager;
};

describe('WorkspaceEntityManager transaction query runner', () => {
  const transactionRunner = { isTransactionActive: true } as QueryRunner;
  const overrideRunner = { isTransactionActive: true } as QueryRunner;

  afterEach(() => {
    jest.restoreAllMocks();
  });

  it('retains the manager runner for an aliased query', async () => {
    const manager = await createManager(transactionRunner);

    expect(
      manager.createQueryBuilder('workspaceMember', 'workspaceMember'),
    ).toHaveProperty('queryRunner', transactionRunner);
  });

  it('retains the manager runner for a query without an alias', async () => {
    const manager = await createManager(transactionRunner);

    expect(manager.createQueryBuilder()).toHaveProperty(
      'queryRunner',
      transactionRunner,
    );
  });

  it('keeps an explicit aliased runner ahead of the manager runner', async () => {
    const manager = await createManager(transactionRunner);

    expect(
      manager.createQueryBuilder(
        'workspaceMember',
        'workspaceMember',
        overrideRunner,
      ),
    ).toHaveProperty('queryRunner', overrideRunner);
  });

  it('keeps an explicit first-argument runner ahead of the manager runner', async () => {
    const manager = await createManager(transactionRunner);

    expect(manager.createQueryBuilder(overrideRunner)).toHaveProperty(
      'queryRunner',
      overrideRunner,
    );
  });

  it('keeps an explicit third-argument runner without an alias', async () => {
    const manager = await createManager(transactionRunner);

    expect(
      manager.createQueryBuilder(undefined, undefined, overrideRunner),
    ).toHaveProperty('queryRunner', overrideRunner);
  });

  it('does not bind queries outside a transaction', async () => {
    const manager = await createManager();

    expect(
      manager.createQueryBuilder('workspaceMember', 'workspaceMember'),
    ).toHaveProperty('queryRunner', undefined);
    expect(manager.createQueryBuilder()).toHaveProperty(
      'queryRunner',
      undefined,
    );
  });

  it.each([{ id: 'member-id' }, 'member-id'])(
    'retains the runner through manager.update with criteria %p',
    async (criteria) => {
      const manager = await createManager(transactionRunner);
      jest.spyOn(WorkspaceUpdateQueryBuilder.prototype, 'set').mockReturnThis();
      const execute = jest
        .spyOn(WorkspaceUpdateQueryBuilder.prototype, 'execute')
        .mockResolvedValue({ affected: 1, raw: [], generatedMaps: [] });

      await manager.update('workspaceMember', criteria, {
        userEmail: 'refreshed@example.com',
      });

      expect(execute).toHaveBeenCalledTimes(1);
      expect(execute.mock.instances[0]).toHaveProperty(
        'queryRunner',
        transactionRunner,
      );
    },
  );
});
