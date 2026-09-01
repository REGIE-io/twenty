import { PhoneSearchMetadataGateService } from 'src/engine/core-modules/phone-search-index/services/phone-search-metadata-gate.service';

describe('PhoneSearchMetadataGateService', () => {
  it('blocks an active operation but permits only its matching internal generation', async () => {
    const dataSource = {
      query: jest.fn().mockResolvedValue([
        {
          id: 'operation',
          status: 'RUNNING',
          kind: 'INITIALIZE',
          generation: '4',
          processedRecordCount: '20',
        },
      ]),
    };
    const service = new PhoneSearchMetadataGateService(dataSource as never);
    await expect(
      service.assertAvailable({ workspaceId: 'w', objectMetadataId: 'p' }),
    ).rejects.toMatchObject({
      response: expect.objectContaining({ code: 'PHONE_SEARCH_METADATA_BUSY' }),
    });
    await expect(
      service.assertAvailable({
        workspaceId: 'w',
        objectMetadataId: 'p',
        operationId: 'operation',
        generation: 4,
      }),
    ).resolves.toBeUndefined();
    expect(dataSource.query.mock.calls[0]?.[0]).toContain(
      'pg_advisory_xact_lock',
    );
  });

  it('uses the migration transaction manager for both lock and re-check', async () => {
    const dataSource = { query: jest.fn() };
    const manager = { query: jest.fn().mockResolvedValue([]) };
    const service = new PhoneSearchMetadataGateService(dataSource as never);
    await service.assertAvailable({
      workspaceId: 'w',
      objectMetadataId: 'p',
      manager: manager as never,
    });
    expect(manager.query).toHaveBeenCalledTimes(2);
    expect(dataSource.query).not.toHaveBeenCalled();
  });
});
