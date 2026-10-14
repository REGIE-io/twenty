import { type DiscoveryService, type Reflector } from '@nestjs/core';

import { WorkspaceCacheProvider } from 'src/engine/workspace-cache/interfaces/workspace-cache-provider.service';

import { type CacheStorageService } from 'src/engine/core-modules/cache-storage/services/cache-storage.service';
import { type TwentyConfigService } from 'src/engine/core-modules/twenty-config/twenty-config.service';
import { WORKSPACE_CACHE_KEY } from 'src/engine/workspace-cache/decorators/workspace-cache.decorator';
import { type WorkspaceCacheMetricsService } from 'src/engine/workspace-cache/services/workspace-cache-metrics.service';
import { WorkspaceCacheService } from 'src/engine/workspace-cache/services/workspace-cache.service';
import { type WorkspaceCacheDataMap } from 'src/engine/workspace-cache/types/workspace-cache-key.type';

const WORKSPACE_ID = '20202020-1c25-4d02-bf25-6aeccf7ea419';

type FakeIndexMaps = { version: string };

const asIndexMaps = (value: FakeIndexMaps) =>
  value as unknown as WorkspaceCacheDataMap['flatIndexMaps'];

// One Redis shared by every process, with a hook to hold a data read after it has
// captured its values, so a read can be left in flight across another process's write.
const createSharedRedis = () => {
  const store = new Map<string, unknown>();
  let heldDataRead: Promise<void> | undefined;

  const storage = {
    get: async (key: string) => store.get(key),
    mget: async (keys: string[]) => {
      const values = keys.map((key) => store.get(key));
      const hold = heldDataRead;

      if (hold && keys.some((key) => key.endsWith(':data'))) {
        heldDataRead = undefined;
        await hold;
      }

      return values;
    },
    mset: async (entries: Array<{ key: string; value: unknown }>) => {
      entries.forEach(({ key, value }) => store.set(key, value));
    },
    mdel: async (keys: string[]) => {
      keys.forEach((key) => store.delete(key));
    },
    setIfAbsent: async (key: string, value: unknown) => {
      if (!store.has(key)) {
        store.set(key, value);
      }
    },
  };

  const holdNextDataRead = () => {
    let release = () => {};

    heldDataRead = new Promise<void>((resolve) => {
      release = resolve;
    });

    return release;
  };

  return {
    storage: storage as unknown as CacheStorageService,
    holdNextDataRead,
  };
};

class FakeIndexMapsProvider extends WorkspaceCacheProvider {
  constructor(private readonly database: { indexMaps: FakeIndexMaps }) {
    super();
  }

  async computeForCache() {
    return asIndexMaps({ ...this.database.indexMaps });
  }
}

const startProcess = async (
  storage: CacheStorageService,
  database: { indexMaps: FakeIndexMaps },
) => {
  const provider = new FakeIndexMapsProvider(database);
  const service = new WorkspaceCacheService(
    storage,
    {
      getProviders: () => [{ instance: provider }],
    } as unknown as DiscoveryService,
    {
      get: (metadataKey: string) =>
        metadataKey === WORKSPACE_CACHE_KEY ? 'flatIndexMaps' : undefined,
    } as unknown as Reflector,
    {
      start: jest.fn(),
      stop: jest.fn(),
      recordRecompute: jest.fn(),
      recordRedisWrite: jest.fn(),
      recordUnpacking: jest.fn(),
      recordPackingRun: jest.fn(),
    } as unknown as WorkspaceCacheMetricsService,
    { get: () => 3600 } as unknown as TwentyConfigService,
  );

  await service.onModuleInit();

  return service;
};

const readIndexMaps = async (service: WorkspaceCacheService) => {
  const { flatIndexMaps } = await service.getOrRecompute(WORKSPACE_ID, [
    'flatIndexMaps',
  ]);

  return flatIndexMaps as unknown as FakeIndexMaps;
};

describe('WorkspaceCacheService across processes', () => {
  const processes: WorkspaceCacheService[] = [];

  const startTwoProcesses = async () => {
    const redis = createSharedRedis();
    const database = { indexMaps: { version: 'before-write' } };
    const writer = await startProcess(redis.storage, database);
    const reader = await startProcess(redis.storage, database);

    processes.push(writer, reader);

    return { redis, database, writer, reader };
  };

  afterEach(() => {
    processes.splice(0).forEach((service) => service.onModuleDestroy());
  });

  it('serves another process its write as soon as that write has returned', async () => {
    const { database, writer, reader } = await startTwoProcesses();

    expect(await readIndexMaps(reader)).toEqual({ version: 'before-write' });

    database.indexMaps = { version: 'after-write' };
    await writer.invalidateAndRecompute(WORKSPACE_ID, ['flatIndexMaps']);

    expect(await readIndexMaps(reader)).toEqual({ version: 'after-write' });
  });

  it('does not hand a read that starts after a write the result of one still in flight from before it', async () => {
    const { redis, database, writer, reader } = await startTwoProcesses();

    await readIndexMaps(writer);

    const release = redis.holdNextDataRead();
    const readStartedBeforeWrite = readIndexMaps(reader);

    database.indexMaps = { version: 'after-write' };
    await writer.invalidateAndRecompute(WORKSPACE_ID, ['flatIndexMaps']);

    const readStartedAfterWrite = readIndexMaps(reader);

    release();

    expect(await readStartedAfterWrite).toEqual({ version: 'after-write' });
    expect(await readStartedBeforeWrite).toEqual({ version: 'before-write' });
  });
});
