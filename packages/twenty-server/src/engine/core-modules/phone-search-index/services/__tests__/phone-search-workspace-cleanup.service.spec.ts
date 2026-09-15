import { PhoneSearchWorkspaceCleanupService } from 'src/engine/core-modules/phone-search-index/services/phone-search-workspace-cleanup.service';

describe('PhoneSearchWorkspaceCleanupService', () => {
  it('does nothing before the lookup infrastructure is installed', async () => {
    const dataSource = {
      query: jest
        .fn()
        .mockResolvedValue([
          { lookupExists: false, stateExists: false, operationExists: false },
        ]),
    };
    const service = new PhoneSearchWorkspaceCleanupService(dataSource as never);

    await service.cleanupWorkspace('workspace');

    expect(dataSource.query).toHaveBeenCalledTimes(1);
  });

  it('deletes lookup PII in bounded batches, then its state and operations', async () => {
    const dataSource = {
      query: jest
        .fn()
        .mockResolvedValueOnce([
          { lookupExists: true, stateExists: true, operationExists: true },
        ])
        .mockResolvedValueOnce(
          Array.from({ length: 1_000 }, (_, id) => ({ id })),
        )
        .mockResolvedValueOnce([{ id: 'last' }])
        .mockResolvedValue([]),
    };
    const service = new PhoneSearchWorkspaceCleanupService(dataSource as never);

    await service.cleanupWorkspace('workspace');

    expect(dataSource.query).toHaveBeenCalledTimes(5);
    expect(dataSource.query.mock.calls[1]?.[0]).toContain('LIMIT 1000');
    expect(dataSource.query.mock.calls[3]?.[0]).toContain(
      'phoneSearchFieldState',
    );
    expect(dataSource.query.mock.calls[4]?.[0]).toContain(
      'phoneSearchIndexOperation',
    );
  });

  it('cleans every installed table independently and remains idempotent', async () => {
    const dataSource = {
      query: jest
        .fn()
        .mockResolvedValueOnce([
          { lookupExists: true, stateExists: false, operationExists: true },
        ])
        .mockResolvedValueOnce([])
        .mockResolvedValueOnce([])
        .mockResolvedValueOnce([
          { lookupExists: false, stateExists: true, operationExists: false },
        ])
        .mockResolvedValueOnce([]),
    };
    const service = new PhoneSearchWorkspaceCleanupService(dataSource as never);

    await service.cleanupWorkspace('workspace');
    await service.cleanupWorkspace('workspace');

    expect(dataSource.query.mock.calls.map(([sql]) => sql)).toEqual(
      expect.arrayContaining([
        expect.stringContaining('personPhoneLookup'),
        expect.stringContaining('phoneSearchIndexOperation'),
        expect.stringContaining('phoneSearchFieldState'),
      ]),
    );
  });
});
