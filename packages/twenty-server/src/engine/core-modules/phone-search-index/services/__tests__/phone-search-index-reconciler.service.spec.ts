import { PhoneSearchIndexReconcilerService } from 'src/engine/core-modules/phone-search-index/services/phone-search-index-reconciler.service';

describe('PhoneSearchIndexReconcilerService', () => {
  it('re-enqueues durable pending work and expired leases after Redis loss', async () => {
    const dataSource = {
      query: jest
        .fn()
        .mockResolvedValue([{ id: 'pending' }, { id: 'expired' }]),
    };
    const queue = { add: jest.fn().mockResolvedValue(undefined) };
    const service = new PhoneSearchIndexReconcilerService(
      dataSource as never,
      queue as never,
    );

    await expect(service.reconcile()).resolves.toBe(2);
    expect(dataSource.query.mock.calls[0]?.[0]).toContain(
      '"leaseExpiresAt" IS NULL OR "leaseExpiresAt" < now()',
    );
    expect(dataSource.query.mock.calls[0]?.[0]).not.toContain("'FAILED'");
    expect(queue.add).toHaveBeenCalledWith('PhoneSearchIndexJob', {
      operationId: 'pending',
    });
    expect(queue.add).toHaveBeenCalledWith('PhoneSearchIndexJob', {
      operationId: 'expired',
    });
  });
});
