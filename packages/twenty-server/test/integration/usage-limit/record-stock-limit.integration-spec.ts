import { createManyOperationFactory } from 'test/integration/graphql/utils/create-many-operation-factory.util';
import { deleteManyOperationFactory } from 'test/integration/graphql/utils/delete-many-operation-factory.util';
import { destroyManyOperationFactory } from 'test/integration/graphql/utils/destroy-many-operation-factory.util';
import { makeGraphqlApiRequest } from 'test/integration/graphql/utils/make-graphql-api-request.util';
import { expectEventually } from 'test/integration/utils/expect-eventually.util';
import { getAppProviderByClassName } from 'test/integration/utils/get-app-provider-by-class-name.util';
import { getCoreRepository } from 'test/integration/utils/get-core-repository.util';
import { waitForAllJobsToFinish } from 'test/integration/utils/wait-for-all-jobs-to-finish.util';

import { type Repository } from 'typeorm';
import { v4 } from 'uuid';

import { type CacheStorageService } from 'src/engine/core-modules/cache-storage/services/cache-storage.service';
import { CacheStorageNamespace } from 'src/engine/core-modules/cache-storage/types/cache-storage-namespace.enum';
import { COUNT_LIVE_RECORDS_QUERY } from 'src/engine/core-modules/usage-limit/constants/count-live-records-query.constant';
import { type UsageLimitStockService } from 'src/engine/core-modules/usage-limit/services/usage-limit-stock.service';
import { buildRecordStockTableNames } from 'src/engine/core-modules/usage-limit/utils/build-record-stock-table-names.util';
import { buildStockCounterKey } from 'src/engine/core-modules/usage-limit/utils/build-stock-counter-key.util';
import { UsageLimitEntity } from 'src/engine/core-modules/usage-limit/usage-limit.entity';
import { UsageOperationType } from 'src/engine/core-modules/usage/enums/usage-operation-type.enum';
import { UsageResourceType } from 'src/engine/core-modules/usage/enums/usage-resource-type.enum';
import { UsageUnit } from 'src/engine/core-modules/usage/enums/usage-unit.enum';
import { type WorkspaceCacheService } from 'src/engine/workspace-cache/services/workspace-cache.service';
import { type WorkspaceOrmManager } from 'src/engine/twenty-orm/workspace-orm.manager';
import { getWorkspaceSchemaName } from 'src/engine/workspace-datasource/utils/get-workspace-schema-name.util';
import { SEED_APPLE_WORKSPACE_ID } from 'src/engine/workspace-manager/dev-seeder/core/constants/seeder-workspaces.constant';
import { escapeIdentifier } from 'src/engine/workspace-manager/workspace-migration/utils/remove-sql-injection.util';

const SCHEMA_NAME = getWorkspaceSchemaName(SEED_APPLE_WORKSPACE_ID);
const HEADROOM = 2;
const STATS_FLUSH_TIMEOUT_MS = 30_000;

describe('Record stock limit', () => {
  let usageLimitRepository: Repository<UsageLimitEntity>;
  let usageLimitId: string;
  let baselineRecordCount: number;
  let trackedTableNames: string[];
  let savedUsageLimits: UsageLimitEntity[] = [];
  const createdRocketIds: string[] = [];

  const createRockets = async (count: number) => {
    const ids = Array.from({ length: count }, () => v4());

    createdRocketIds.push(...ids);

    return makeGraphqlApiRequest(
      createManyOperationFactory({
        objectMetadataSingularName: 'rocket',
        objectMetadataPluralName: 'rockets',
        gqlFields: 'id',
        data: ids.map((id) => ({ id, name: 'Record stock test' })),
      }),
    );
  };

  const softDeleteRockets = (ids: string[]) =>
    makeGraphqlApiRequest(
      deleteManyOperationFactory({
        objectMetadataSingularName: 'rocket',
        objectMetadataPluralName: 'rockets',
        gqlFields: 'id',
        filter: { id: { in: ids } },
      }),
    );

  const destroyRockets = (ids: string[]) =>
    makeGraphqlApiRequest(
      destroyManyOperationFactory({
        objectMetadataSingularName: 'rocket',
        objectMetadataPluralName: 'rockets',
        gqlFields: 'id',
        filter: { id: { in: ids } },
      }),
    );

  const findTrackedTableNames = async (): Promise<string[]> => {
    const { flatObjectMetadataMaps } =
      await getAppProviderByClassName<WorkspaceCacheService>(
        'WorkspaceCacheService',
      ).getOrRecompute(SEED_APPLE_WORKSPACE_ID, ['flatObjectMetadataMaps']);

    return buildRecordStockTableNames(flatObjectMetadataMaps);
  };

  const analyzeTrackedTables = async () => {
    // The new ORM writes through a separate pool. Pending deltas from those
    // backends can arrive after ANALYZE and move an otherwise correct baseline.
    // Both ORM generations have a WorkspaceSchemaService; follow the active manager.
    const pool = getAppProviderByClassName<WorkspaceOrmManager>(
      'WorkspaceOrmManager',
    )['workspaceSchemaService']['primaryPool'];

    if (!pool) {
      throw new Error('Workspace primary pool is not initialized');
    }

    const clients = await Promise.all(
      Array.from({ length: pool.totalCount }, () => pool.connect()),
    );

    try {
      await Promise.all(
        clients.map(async (client) => {
          await client.query('SELECT pg_stat_force_next_flush()');
          await client.query('SELECT 1');
        }),
      );
    } finally {
      clients.forEach((client) => client.release());
    }

    await global.testDataSource.query(
      `ANALYZE ${trackedTableNames
        .map(
          (tableName) =>
            `${escapeIdentifier(SCHEMA_NAME)}.${escapeIdentifier(tableName)}`,
        )
        .join(', ')}`,
    );
  };

  const countActualRecords = async (): Promise<number> => {
    const [row]: { quantity: string }[] = await global.testDataSource.query(
      `SELECT SUM(quantity)::bigint AS quantity FROM (${trackedTableNames
        .map(
          (tableName) =>
            `SELECT COUNT(*) AS quantity FROM ${escapeIdentifier(SCHEMA_NAME)}.${escapeIdentifier(tableName)}`,
        )
        .join(' UNION ALL ')}) AS record_counts`,
    );

    return Number(row.quantity);
  };

  const countRecords = async (): Promise<number> => {
    const [row]: { quantity: string }[] = await global.testDataSource.query(
      COUNT_LIVE_RECORDS_QUERY,
      [SCHEMA_NAME, trackedTableNames],
    );

    return Number(row.quantity);
  };

  const waitForRecordCount = (expected: number) =>
    expectEventually(
      async () => {
        expect(await countRecords()).toBe(expected);
      },
      { timeoutMs: STATS_FLUSH_TIMEOUT_MS },
    );

  const synchronizeRecordStats = async (): Promise<number> => {
    await waitForAllJobsToFinish();
    const actual = await countActualRecords();

    // Equal statistics samples can both be stale. Calibrate against real rows.
    await analyzeTrackedTables();
    await waitForRecordCount(actual);

    return actual;
  };

  const dropStockCounter = () =>
    getAppProviderByClassName<UsageLimitStockService>(
      'UsageLimitStockService',
    ).invalidateStock({
      workspaceId: SEED_APPLE_WORKSPACE_ID,
      resourceType: UsageResourceType.RECORD,
      operationType: UsageOperationType.RECORD_WRITE,
      spenders: {},
    });

  const readStockCounter = () =>
    global.app
      .get<CacheStorageService>(CacheStorageNamespace.EngineUsageLimit)
      .get<number>(
        buildStockCounterKey({
          workspaceId: SEED_APPLE_WORKSPACE_ID,
          counter: {
            resourceType: UsageResourceType.RECORD,
            operationType: UsageOperationType.RECORD_WRITE,
            spenderType: 'workspace',
            spenderId: null,
            unit: UsageUnit.RECORD,
          },
        }),
      );

  const refreshUsageLimitsCache = () =>
    getAppProviderByClassName<WorkspaceCacheService>(
      'WorkspaceCacheService',
    ).invalidateAndRecompute(SEED_APPLE_WORKSPACE_ID, ['usageLimits']);

  const expectRefused = (response: { body: { errors?: unknown[] } }) => {
    expect(
      (response.body.errors?.[0] as { extensions?: { subCode?: string } })
        ?.extensions?.subCode,
    ).toBe('STOCK_EXHAUSTED');
  };

  const expectAdmitted = (response: { body: { errors?: unknown[] } }) => {
    expect(response.body.errors).toBeUndefined();
  };

  beforeAll(async () => {
    usageLimitRepository =
      getCoreRepository<UsageLimitEntity>(UsageLimitEntity);

    trackedTableNames = await findTrackedTableNames();
    expect(trackedTableNames).toContain('_rocket');
    savedUsageLimits = await usageLimitRepository.findBy({
      workspaceId: SEED_APPLE_WORKSPACE_ID,
      resourceType: UsageResourceType.RECORD,
    });
    await usageLimitRepository.delete({
      workspaceId: SEED_APPLE_WORKSPACE_ID,
      resourceType: UsageResourceType.RECORD,
    });
    baselineRecordCount = await synchronizeRecordStats();

    const [usageLimit] = await usageLimitRepository.save([
      {
        workspaceId: SEED_APPLE_WORKSPACE_ID,
        resourceType: UsageResourceType.RECORD,
        operationType: UsageOperationType.RECORD_WRITE,
        spenderType: 'workspace',
        spenderId: '',
        limitKind: 'stock',
        periodCount: 1,
        periodUnit: 'lifetime',
        unit: UsageUnit.RECORD,
        limitValue: baselineRecordCount + HEADROOM,
        burstValue: null,
      },
    ]);

    usageLimitId = usageLimit.id;

    await refreshUsageLimitsCache();
  }, STATS_FLUSH_TIMEOUT_MS + 5_000);

  beforeEach(async () => {
    baselineRecordCount = await synchronizeRecordStats();
    await usageLimitRepository.update(usageLimitId, {
      limitValue: baselineRecordCount + HEADROOM,
    });
    await refreshUsageLimitsCache();
    await dropStockCounter();
    expect(await readStockCounter()).toBeUndefined();
  }, STATS_FLUSH_TIMEOUT_MS + 5_000);

  afterEach(async () => {
    if (createdRocketIds.length > 0) {
      const queryRunner = global.testDataSource.createQueryRunner();

      await queryRunner.connect();
      try {
        await queryRunner.query(
          `DELETE FROM "${SCHEMA_NAME}"."_rocket" WHERE id = ANY($1)`,
          [createdRocketIds],
        );
        // Flush the DELETE from its own backend before the next test warms Redis.
        await queryRunner.query('SELECT pg_stat_force_next_flush()');
        createdRocketIds.length = 0;
      } finally {
        await queryRunner.release();
      }
    }
    await waitForAllJobsToFinish();
    await analyzeTrackedTables();
    await dropStockCounter();
  });

  afterAll(async () => {
    await dropStockCounter();
    if (usageLimitId) {
      await usageLimitRepository.delete({ id: usageLimitId });
    }
    if (savedUsageLimits.length > 0) {
      await usageLimitRepository.save(savedUsageLimits);
    }
    await refreshUsageLimitsCache();
  });

  it('refuses the write that would cross the limit', async () => {
    expectAdmitted(await createRockets(HEADROOM));
    expect(await readStockCounter()).toBe(baselineRecordCount + HEADROOM);
    expectRefused(await createRockets(1));
  });

  it('refuses a batch as a whole when only part of it fits', async () => {
    expectRefused(await createRockets(HEADROOM + 1));
    expect(await countActualRecords()).toBe(baselineRecordCount);
    expectAdmitted(await createRockets(HEADROOM));
  });

  it('gives the capacity back when records are destroyed', async () => {
    const admitted = await createRockets(HEADROOM);

    expectAdmitted(admitted);
    expectRefused(await createRockets(1));

    await destroyRockets([admitted.body.data.createRockets[0].id]);

    expect(await readStockCounter()).toBe(baselineRecordCount + HEADROOM - 1);
    expectAdmitted(await createRockets(1));
  });

  it('keeps soft-deleted records counted until they are destroyed', async () => {
    const admitted = await createRockets(HEADROOM);

    expectAdmitted(admitted);

    await softDeleteRockets([admitted.body.data.createRockets[0].id]);

    expectRefused(await createRockets(1));
  });

  it('rewarms a cold counter from PostgreSQL including existing records', async () => {
    expectAdmitted(await createRockets(HEADROOM));
    await analyzeTrackedTables();
    await waitForRecordCount(baselineRecordCount + HEADROOM);
    await dropStockCounter();

    expectRefused(await createRockets(1));
  });
});
