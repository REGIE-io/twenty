import { PhoneSearchTriggerManagerService } from 'src/engine/core-modules/phone-search-index/services/phone-search-trigger-manager.service';

const WORKSPACE_ID = '00000000-0000-0000-0000-000000000001';
const OBJECT_METADATA_ID = '00000000-0000-0000-0000-000000000002';

describe('PhoneSearchTriggerManagerService', () => {
  const createRunner = (isInstalled: boolean) => {
    const runner = {
      isTransactionActive: false,
      connect: jest.fn(),
      startTransaction: jest.fn(async () => {
        runner.isTransactionActive = true;
      }),
      commitTransaction: jest.fn(async () => {
        runner.isTransactionActive = false;
      }),
      rollbackTransaction: jest.fn(),
      release: jest.fn(),
      query: jest.fn(async (sql: string) => {
        if (sql.includes('SELECT EXISTS')) return [{ isInstalled }];

        return [];
      }),
    };

    return runner;
  };

  it('does not take a Person DDL lock when the correct trigger is installed', async () => {
    const runner = createRunner(true);
    const service = new PhoneSearchTriggerManagerService({
      createQueryRunner: jest.fn().mockReturnValue(runner),
    } as never);

    await service.install({
      workspaceId: WORKSPACE_ID,
      objectMetadataId: OBJECT_METADATA_ID,
    });

    expect(runner.commitTransaction).toHaveBeenCalledTimes(1);
    expect(runner.query).not.toHaveBeenCalledWith(
      expect.stringContaining('lock_timeout'),
    );
    expect(runner.query).not.toHaveBeenCalledWith(
      expect.stringContaining('DROP TRIGGER'),
    );
    expect(runner.query).not.toHaveBeenCalledWith(
      expect.stringContaining('CREATE TRIGGER'),
    );
    expect(runner.release).toHaveBeenCalledTimes(1);
  });

  it('replaces a missing or stale trigger under a bounded lock', async () => {
    const runner = createRunner(false);
    const service = new PhoneSearchTriggerManagerService({
      createQueryRunner: jest.fn().mockReturnValue(runner),
    } as never);

    await service.install({
      workspaceId: WORKSPACE_ID,
      objectMetadataId: OBJECT_METADATA_ID,
    });

    expect(runner.query).toHaveBeenCalledWith(
      expect.stringContaining("SET LOCAL lock_timeout = '2s'"),
    );
    expect(runner.query).toHaveBeenCalledWith(
      expect.stringContaining('DROP TRIGGER IF EXISTS'),
    );
    expect(runner.query).toHaveBeenCalledWith(
      expect.stringContaining('CREATE TRIGGER'),
    );
    expect(runner.commitTransaction).toHaveBeenCalledTimes(1);
  });
});
