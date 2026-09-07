import {
  PHONE_SEARCH_INDEX_MAX_CONSECUTIVE_FAILURES,
  PhoneSearchIndexBackfillService,
} from 'src/engine/core-modules/phone-search-index/services/phone-search-index-backfill.service';

const operation = {
  workspaceId: '550e8400-e29b-41d4-a716-446655440000',
  objectMetadataId: '550e8400-e29b-41d4-a716-446655440001',
  generation: '2',
  lastRecordId: null,
  status: 'PENDING',
  kind: 'REPAIR',
  fieldMetadataIds: ['550e8400-e29b-41d4-a716-446655440002'],
  leaseExpiresAt: null,
};

const makeFailingRunner = () => {
  const runner = {
    isTransactionActive: false,
    connect: jest.fn(),
    startTransaction: jest.fn(async () => {
      runner.isTransactionActive = true;
    }),
    commitTransaction: jest.fn(async () => {
      runner.isTransactionActive = false;
    }),
    rollbackTransaction: jest.fn(async () => {
      runner.isTransactionActive = false;
    }),
    release: jest.fn(),
    query: jest.fn(async (sql: string) => {
      if (sql.includes('SELECT * FROM core."phoneSearchIndexOperation"'))
        return [operation];
      if (sql.includes('SELECT p.id, to_jsonb(p)'))
        throw new Error('database unavailable\nwith control text');
      return [];
    }),
  };

  return runner;
};

describe('PhoneSearchIndexBackfillService', () => {
  it('sets lock and configurable statement timeouts and durably records a retry after rollback', async () => {
    const runner = makeFailingRunner();
    const manager = {
      query: jest.fn().mockResolvedValueOnce([{ status: 'RETRYABLE' }]),
    };
    const dataSource = {
      createQueryRunner: jest.fn().mockReturnValue(runner),
      transaction: jest.fn((callback) => callback(manager)),
    };
    const service = new PhoneSearchIndexBackfillService(
      dataSource as never,
      { add: jest.fn() } as never,
      { get: jest.fn().mockReturnValue(17000) } as never,
    );

    await expect(service.runBatch('operation')).rejects.toThrow(
      'database unavailable',
    );
    expect(runner.query).toHaveBeenCalledWith("SET LOCAL lock_timeout = '2s'");
    expect(runner.query).toHaveBeenCalledWith(
      "SET LOCAL statement_timeout = '17000ms'",
    );
    expect(runner.rollbackTransaction).toHaveBeenCalledTimes(1);
    expect(dataSource.transaction).toHaveBeenCalledTimes(1);
    expect(manager.query.mock.calls[0]?.[0]).toContain(
      '"attemptCount" = "attemptCount" + 1',
    );
    expect(manager.query.mock.calls[0]?.[1]).toEqual([
      'operation',
      PHONE_SEARCH_INDEX_MAX_CONSECUTIVE_FAILURES,
      'database unavailable with control text',
    ]);
  });

  it('transitions terminal failures, preserves the active generation, and queues inactive-generation cleanup', async () => {
    const runner = makeFailingRunner();
    const manager = {
      query: jest
        .fn()
        .mockResolvedValueOnce([{ status: 'FAILED' }])
        .mockResolvedValueOnce([])
        .mockResolvedValueOnce([{ id: 'cleanup-operation' }]),
    };
    const queue = { add: jest.fn().mockResolvedValue(undefined) };
    const dataSource = {
      createQueryRunner: jest.fn().mockReturnValue(runner),
      transaction: jest.fn((callback) => callback(manager)),
    };
    const service = new PhoneSearchIndexBackfillService(
      dataSource as never,
      queue as never,
      { get: jest.fn().mockReturnValue(30000) } as never,
    );

    await expect(service.runBatch('operation')).rejects.toThrow();
    const stateSql = String(manager.query.mock.calls[1]?.[0]);

    expect(stateSql).toContain('"buildingProjectionGeneration" = NULL');
    expect(stateSql).not.toContain('"activeProjectionGeneration" = NULL');
    expect(manager.query.mock.calls[2]?.[0]).toContain('PURGE_GENERATION');
    expect(queue.add).toHaveBeenCalledWith('PhoneSearchIndexJob', {
      operationId: 'cleanup-operation',
    });
  });

  it('resets consecutive failures after a successful empty final batch', async () => {
    const runner = makeFailingRunner();

    runner.query.mockImplementation(async (sql: string) => {
      if (sql.includes('SELECT * FROM core."phoneSearchIndexOperation"'))
        return [operation];
      if (sql.includes('SELECT p.id, to_jsonb(p)')) return [];
      if (sql.includes('SELECT "fieldMetadataId"')) return [];
      if (sql.includes('PURGE_GENERATION')) return [];
      return [];
    });
    const dataSource = {
      createQueryRunner: jest.fn().mockReturnValue(runner),
      transaction: jest.fn(),
    };
    const service = new PhoneSearchIndexBackfillService(
      dataSource as never,
      { add: jest.fn() } as never,
      { get: jest.fn().mockReturnValue(30000) } as never,
    );

    await expect(service.runBatch('operation')).resolves.toBe(true);
    expect(
      runner.query.mock.calls.some(([sql]) =>
        String(sql).includes('"attemptCount" = 0'),
      ),
    ).toBe(true);
    expect(dataSource.transaction).not.toHaveBeenCalled();
  });

  it('does not hide the original batch error when failure bookkeeping also fails', async () => {
    const runner = makeFailingRunner();
    const dataSource = {
      createQueryRunner: jest.fn().mockReturnValue(runner),
      transaction: jest.fn().mockRejectedValue(new Error('bookkeeping failed')),
    };
    const service = new PhoneSearchIndexBackfillService(
      dataSource as never,
      { add: jest.fn() } as never,
      { get: jest.fn().mockReturnValue(30000) } as never,
    );

    await expect(service.runBatch('operation')).rejects.toThrow(
      'database unavailable',
    );
  });
});
