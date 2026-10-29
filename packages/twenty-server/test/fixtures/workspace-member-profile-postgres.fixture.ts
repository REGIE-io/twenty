import { randomUUID } from 'crypto';

import { FeatureFlagKey } from 'twenty-shared/types';
import {
  DataSource,
  EntityManager,
  EntitySchema,
  type ObjectLiteral,
  type Repository,
  SelectQueryBuilder,
} from 'typeorm';

import { InternalWorkspaceMemberProvisioningService } from 'src/engine/core-modules/workspace/internal/internal-workspace-member-provisioning.service';
import { WorkspaceEntityManager } from 'src/engine/twenty-orm/entity-manager/workspace-entity-manager';
import { GlobalWorkspaceOrmManager } from 'src/engine/twenty-orm/global-workspace-datasource/global-workspace-orm.manager';
import { type WorkspaceRepository } from 'src/engine/twenty-orm/repository/workspace.repository';
import { getWorkspaceContext } from 'src/engine/twenty-orm/storage/orm-workspace-context.storage';
import { getWorkspaceSchemaName } from 'src/engine/workspace-datasource/utils/get-workspace-schema-name.util';

export type ProfileTestMember = {
  id: string;
  userId: string;
  userEmail: string;
  name: { firstName: string; lastName: string };
  deletedAt: Date | null;
};

class TransactionProbeQueryBuilder extends SelectQueryBuilder<ProfileTestMember> {
  getTransactionRunner() {
    return this.queryRunner;
  }
}

const NameSchema = new EntitySchema({
  name: 'ProfileTestName',
  columns: {
    firstName: { type: String },
    lastName: { type: String },
  },
});

const memberSchema = (workspaceId: string) =>
  new EntitySchema<ProfileTestMember>({
    name: `ProfileTestMember_${workspaceId}`,
    schema: getWorkspaceSchemaName(workspaceId),
    tableName: 'workspaceMember',
    columns: {
      id: { type: 'uuid', primary: true },
      userId: { type: 'uuid' },
      userEmail: { type: String },
      deletedAt: { type: Date, nullable: true, deleteDate: true },
    },
    embeddeds: { name: { schema: NameSchema, prefix: 'name' } },
  });

// This fixture uses real TypeORM repositories and PostgreSQL transactions. It
// does not bootstrap Twenty metadata or its workspace repository extensions.
// Both transaction branches and workspace-context selection are production code.
// V1 also uses its real query-builder runner selection. Metadata formatting and
// events remain outside this fixture and need the full Twenty integration suite.
export const createProfilePostgresFixture = async (
  databaseUrl: string,
  isOrmV2Enabled: boolean,
) => {
  const parsedUrl = new URL(databaseUrl);

  if (
    !['localhost', '127.0.0.1', '[::1]'].includes(parsedUrl.hostname) ||
    !/^\/twenty_member_profile_test(?:_[a-z0-9_]+)?$/.test(parsedUrl.pathname)
  ) {
    throw new Error(
      'Profile tests require an explicit disposable local database',
    );
  }

  const workspaceIds: string[] = [randomUUID(), randomUUID()];
  const schemas = new Map(
    workspaceIds.map((workspaceId) => [workspaceId, memberSchema(workspaceId)]),
  );
  const dataSource = new DataSource({
    type: 'postgres',
    url: databaseUrl,
    entities: [...schemas.values()],
    synchronize: false,
    extra: { max: 8 },
  });

  await dataSource.initialize();

  for (const workspaceId of workspaceIds) {
    await dataSource.query(
      `CREATE SCHEMA "${getWorkspaceSchemaName(workspaceId)}"`,
    );
  }

  await dataSource.synchronize();

  const hooks: {
    afterUpdate?: () => Promise<void>;
    beforeLock?: () => void;
  } = {};
  const repositoryFor = (manager: EntityManager) => {
    const workspaceId = getWorkspaceContext().authContext.workspace.id;
    const schema = schemas.get(workspaceId);

    if (!schema) {
      throw new Error('Unknown test workspace');
    }

    const repository = manager.getRepository(schema);

    return {
      findOne: repository.findOne.bind(repository),
      update: async (...parameters: Parameters<typeof repository.update>) => {
        let updateRepository = repository;

        if (!isOrmV2Enabled) {
          const workspaceManager = new WorkspaceEntityManager(
            dataSource as never,
            manager.queryRunner,
          );
          const queryBuilder = workspaceManager.createQueryBuilder(
            schema,
            'profile',
          );
          const selectedRunner = new TransactionProbeQueryBuilder(
            queryBuilder,
          ).getTransactionRunner();

          if (!selectedRunner || selectedRunner !== manager.queryRunner) {
            throw new Error(
              'Workspace update lost its transaction query runner',
            );
          }

          updateRepository = new EntityManager(
            dataSource,
            selectedRunner,
          ).getRepository(schema);
        }

        const result = await updateRepository.update(...parameters);

        await hooks.afterUpdate?.();

        return result;
      },
    };
  };
  const getRepository = <Entity extends ObjectLiteral>(
    manager: EntityManager,
    objectMetadataName: string,
  ): WorkspaceRepository<Entity> => {
    if (objectMetadataName !== 'workspaceMember') {
      throw new Error('Profile update accessed an unrelated repository');
    }

    return repositoryFor(manager) as unknown as WorkspaceRepository<Entity>;
  };
  const observeQuery = (sql: string) => {
    if (sql.startsWith('LOCK TABLE')) {
      hooks.beforeLock?.();
    }
  };
  const globalDataSource = {
    createQueryRunner: () => {
      const runner = dataSource.createQueryRunner();

      return {
        connect: () => runner.connect(),
        startTransaction: () => runner.startTransaction(),
        commitTransaction: () => runner.commitTransaction(),
        rollbackTransaction: () => runner.rollbackTransaction(),
        release: () => runner.release(),
        get isTransactionActive() {
          return runner.isTransactionActive;
        },
        query: (sql: string, parameters?: unknown[]) => {
          observeQuery(sql);

          return runner.query(sql, parameters);
        },
        manager: {
          getRepository: <Entity extends ObjectLiteral>(name: string) =>
            getRepository<Entity>(runner.manager, name),
        },
      };
    },
  };
  const emptyMaps = {
    byUniversalIdentifier: {},
    universalIdentifierById: {},
    universalIdentifiersByApplicationId: {},
  };
  const ormManager = new GlobalWorkspaceOrmManager(
    {
      getGlobalWorkspaceDataSource: async () => globalDataSource,
    } as never,
    {
      getOrRecompute: async () => ({
        flatObjectMetadataMaps: emptyMaps,
        flatFieldMetadataMaps: emptyMaps,
        flatIndexMaps: emptyMaps,
        flatRowLevelPermissionPredicateMaps: emptyMaps,
        flatRowLevelPermissionPredicateGroupMaps: emptyMaps,
        rolesPermissions: {},
        userWorkspaceRoleMap: {},
        apiKeyRoleMap: {},
        featureFlagsMap: {
          [FeatureFlagKey.IS_ORM_V2_READ_PATH_ENABLED]: isOrmV2Enabled,
        },
        ORMEntityMetadatas: dataSource.entityMetadatas,
      }),
    } as never,
    {
      getDataSource: () => ({
        transaction: <Result>(
          work: (scope: {
            getRepository: <Entity extends ObjectLiteral>(
              name: string,
            ) => WorkspaceRepository<Entity>;
            executeRawQuery: (
              sql: string,
              parameters?: unknown[],
            ) => Promise<unknown>;
          }) => Promise<Result>,
        ) =>
          dataSource.transaction((manager) =>
            work({
              getRepository: <Entity extends ObjectLiteral>(name: string) =>
                getRepository<Entity>(manager, name),
              executeRawQuery: (sql, parameters) => {
                observeQuery(sql);

                return manager.query(sql, parameters);
              },
            }),
          ),
      }),
    } as never,
  );
  const forbidCoreAccess = jest.fn(() => {
    throw new Error(
      'Profile updates must not access core identity repositories',
    );
  });
  const service = new InternalWorkspaceMemberProvisioningService(
    {
      findOneBy: async ({ id }: { id: string }) =>
        workspaceIds.includes(id) ? { id } : null,
    } as never,
    new Proxy({}, { get: () => forbidCoreAccess }) as never,
    new Proxy({}, { get: () => forbidCoreAccess }) as never,
    ormManager,
  );

  return {
    dataSource,
    service,
    workspaceIds,
    hooks,
    forbidCoreAccess,
    repository: (workspaceId: string): Repository<ProfileTestMember> => {
      const schema = schemas.get(workspaceId);

      if (!schema) {
        throw new Error('Unknown test workspace');
      }

      return dataSource.getRepository(schema);
    },
    close: async () => {
      try {
        for (const workspaceId of workspaceIds) {
          await dataSource.query(
            `DROP SCHEMA "${getWorkspaceSchemaName(workspaceId)}" CASCADE`,
          );
        }
      } finally {
        await dataSource.destroy();
      }
    },
  };
};
