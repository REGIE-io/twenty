import { type DiscoveryService, type Reflector } from '@nestjs/core';

import { CoreEntityCacheProvider } from 'src/engine/core-entity-cache/interfaces/core-entity-cache-provider.service';

import { CORE_ENTITY_CACHE_KEY } from 'src/engine/core-entity-cache/decorators/core-entity-cache.decorator';
import { CoreEntityCacheService } from 'src/engine/core-entity-cache/services/core-entity-cache.service';
import { type CacheStorageService } from 'src/engine/core-modules/cache-storage/services/cache-storage.service';

const SIGNING_KEY_ID = '20202020-8f1a-4c5e-9b0e-3a1c2d4e5f60';

const createSharedRedis = (): CacheStorageService => {
  const store = new Map<string, unknown>();

  return {
    get: async (key: string) => store.get(key),
    mget: async (keys: string[]) => keys.map((key) => store.get(key)),
    mset: async (entries: Array<{ key: string; value: unknown }>) => {
      entries.forEach(({ key, value }) => store.set(key, value));
    },
    mdel: async (keys: string[]) => {
      keys.forEach((key) => store.delete(key));
    },
  } as unknown as CacheStorageService;
};

class FakeSigningKeyProvider extends CoreEntityCacheProvider<string> {
  constructor(private readonly database: { publicKey: string }) {
    super();
  }

  async computeForCache() {
    return this.database.publicKey;
  }
}

const startProcess = async (
  storage: CacheStorageService,
  database: { publicKey: string },
) => {
  const service = new CoreEntityCacheService(
    storage,
    {
      getProviders: () => [{ instance: new FakeSigningKeyProvider(database) }],
    } as unknown as DiscoveryService,
    {
      get: (metadataKey: string) =>
        metadataKey === CORE_ENTITY_CACHE_KEY
          ? 'signingKeyPublicKey'
          : undefined,
    } as unknown as Reflector,
  );

  await service.onModuleInit();

  return service;
};

describe('CoreEntityCacheService across processes', () => {
  const startTwoProcesses = async () => {
    const storage = createSharedRedis();
    const database = { publicKey: 'key-before-rotation' };

    return {
      database,
      writer: await startProcess(storage, database),
      reader: await startProcess(storage, database),
    };
  };

  it('serves another process a recomputed entity as soon as the write has returned', async () => {
    const { database, writer, reader } = await startTwoProcesses();

    expect(await reader.get('signingKeyPublicKey', SIGNING_KEY_ID)).toBe(
      'key-before-rotation',
    );

    database.publicKey = 'key-after-rotation';
    await writer.invalidateAndRecompute('signingKeyPublicKey', SIGNING_KEY_ID);

    expect(await reader.get('signingKeyPublicKey', SIGNING_KEY_ID)).toBe(
      'key-after-rotation',
    );
  });

  it('serves another process fresh data after a plain invalidation', async () => {
    const { database, writer, reader } = await startTwoProcesses();

    await reader.get('signingKeyPublicKey', SIGNING_KEY_ID);

    database.publicKey = 'key-after-rotation';
    await writer.invalidate('signingKeyPublicKey', SIGNING_KEY_ID);

    expect(await reader.get('signingKeyPublicKey', SIGNING_KEY_ID)).toBe(
      'key-after-rotation',
    );
  });
});
