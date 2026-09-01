import { FieldMetadataType } from 'twenty-shared/types';

import { PhoneSearchService } from 'src/engine/core-modules/search/services/phone-search.service';
import { encodeCursorData } from 'src/engine/api/graphql/graphql-query-runner/utils/cursors.util';
import { type GlobalWorkspaceOrmManager } from 'src/engine/twenty-orm/global-workspace-datasource/global-workspace-orm.manager';

jest.mock(
  'src/engine/twenty-orm/storage/orm-workspace-context.storage',
  () => ({
    getWorkspaceContext: () => ({
      authContext: {},
      userWorkspaceRoleMap: {},
      apiKeyRoleMap: {},
    }),
  }),
);

jest.mock(
  'src/engine/twenty-orm/utils/resolve-role-permission-config.util',
  () => ({
    resolveRolePermissionConfig: () => undefined,
  }),
);

describe('PhoneSearchService indexed query contract', () => {
  it.each([null, [], 42, {}, { id: 'not-a-uuid' }])(
    'rejects malformed cursor payload %p before any database query',
    async (payload) => {
      const dataSource = { query: jest.fn() };
      const manager = { executeInWorkspaceContext: jest.fn() };
      const service = new PhoneSearchService(
        manager as unknown as GlobalWorkspaceOrmManager,
        dataSource as never,
      );

      await expect(
        service.searchPeopleByPhone({
          workspace: { id: 'workspace' } as never,
          args: {
            phoneNumber: '+14155550100',
            limit: 10,
            after: Buffer.from(JSON.stringify(payload)).toString('base64'),
          },
          flatObjectMetadataMaps: {} as never,
          flatFieldMetadataMaps: {} as never,
        }),
      ).rejects.toThrow('Invalid phone search cursor');
      expect(manager.executeInWorkspaceContext).not.toHaveBeenCalled();
      expect(dataSource.query).not.toHaveBeenCalled();
    },
  );

  it('accepts a valid UUID cursor', async () => {
    const manager = { executeInWorkspaceContext: jest.fn() };
    const service = new PhoneSearchService(
      manager as unknown as GlobalWorkspaceOrmManager,
      { query: jest.fn() } as never,
    );

    await expect(
      service.searchPeopleByPhone({
        workspace: { id: 'workspace' } as never,
        args: {
          phoneNumber: '+14155550100',
          limit: 10,
          after: encodeCursorData({
            id: '550e8400-e29b-41d4-a716-446655440000',
          }),
        },
        flatObjectMetadataMaps: { byUniversalIdentifier: {} } as never,
        flatFieldMetadataMaps: {} as never,
      }),
    ).resolves.toEqual({
      edges: [],
      pageInfo: { endCursor: null, hasNextPage: false },
    });
    expect(manager.executeInWorkspaceContext).not.toHaveBeenCalled();
  });

  it('rejects a cursor that is not valid encoded JSON', async () => {
    const service = new PhoneSearchService(
      {
        executeInWorkspaceContext: jest.fn(),
      } as unknown as GlobalWorkspaceOrmManager,
      { query: jest.fn() } as never,
    );

    await expect(
      service.searchPeopleByPhone({
        workspace: { id: 'workspace' } as never,
        args: {
          phoneNumber: '+14155550100',
          limit: 10,
          after: Buffer.from('{').toString('base64'),
        },
        flatObjectMetadataMaps: {} as never,
        flatFieldMetadataMaps: {} as never,
      }),
    ).rejects.toBeInstanceOf(Error);
  });

  it('rejects non-E.164 input before querying permissions or the lookup index', async () => {
    const dataSource = { query: jest.fn() };
    const manager = { executeInWorkspaceContext: jest.fn() };
    const service = new PhoneSearchService(
      manager as unknown as GlobalWorkspaceOrmManager,
      dataSource as never,
    );

    await expect(
      service.searchPeopleByPhone({
        workspace: { id: 'workspace' } as never,
        args: { phoneNumber: '4155550100', limit: 10 },
        flatObjectMetadataMaps: {} as never,
        flatFieldMetadataMaps: {} as never,
      }),
    ).rejects.toThrow(
      'phoneNumber must be a valid E.164 international phone number',
    );
    expect(manager.executeInWorkspaceContext).not.toHaveBeenCalled();
    expect(dataSource.query).not.toHaveBeenCalled();
  });

  it('queries only ready readable phone projections and never builds LIKE/ILIKE fallback SQL', async () => {
    const andWhere = jest.fn().mockReturnThis();
    const queryBuilder = {
      select: jest.fn().mockReturnThis(),
      andWhere,
      orderBy: jest.fn().mockReturnThis(),
      take: jest.fn().mockReturnThis(),
      getRawMany: jest.fn().mockResolvedValue([]),
    };
    const repository = {
      objectRecordsPermissions: {
        'person-object': {
          canReadObjectRecords: true,
          restrictedFields: {
            restricted: { canRead: false },
          },
        },
      },
      createQueryBuilder: jest.fn().mockReturnValue(queryBuilder),
    };
    const dataSource = {
      query: jest.fn().mockResolvedValue([
        {
          fieldMetadataId: 'readable',
          isQueryEnabled: true,
          activeProjectionGeneration: '1',
          syncStatus: 'READY',
        },
        {
          fieldMetadataId: 'building',
          isQueryEnabled: true,
          activeProjectionGeneration: null,
          syncStatus: 'INDEXING',
        },
      ]),
    };
    const manager = {
      executeInWorkspaceContext: jest
        .fn()
        .mockImplementation((callback: () => unknown) => callback()),
      getRepository: jest.fn().mockResolvedValue(repository),
    };
    const service = new PhoneSearchService(
      manager as unknown as GlobalWorkspaceOrmManager,
      dataSource as never,
    );
    const readableUniversalIdentifier = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
    const restrictedUniversalIdentifier =
      'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
    const buildingUniversalIdentifier = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';

    await service.searchPeopleByPhone({
      workspace: { id: 'workspace' } as never,
      args: { phoneNumber: '+14155551500', limit: 10 },
      flatObjectMetadataMaps: {
        byUniversalIdentifier: {
          person: {
            id: 'person-object',
            nameSingular: 'person',
            fieldIds: ['readable', 'restricted', 'building'],
            fieldUniversalIdentifiers: [
              readableUniversalIdentifier,
              restrictedUniversalIdentifier,
              buildingUniversalIdentifier,
            ],
          },
        },
      } as never,
      flatFieldMetadataMaps: {
        byUniversalIdentifier: {
          [readableUniversalIdentifier]: {
            id: 'readable',
            universalIdentifier: readableUniversalIdentifier,
            type: FieldMetadataType.PHONES,
            isActive: true,
          },
          [restrictedUniversalIdentifier]: {
            id: 'restricted',
            universalIdentifier: restrictedUniversalIdentifier,
            type: FieldMetadataType.PHONES,
            isActive: true,
          },
          [buildingUniversalIdentifier]: {
            id: 'building',
            universalIdentifier: buildingUniversalIdentifier,
            type: FieldMetadataType.PHONES,
            isActive: true,
          },
        },
        universalIdentifierById: {
          readable: readableUniversalIdentifier,
          restricted: restrictedUniversalIdentifier,
          building: buildingUniversalIdentifier,
        },
      } as never,
    });

    const whereSql = andWhere.mock.calls.map(([sql]) => String(sql)).join('\n');
    const queryParameters = andWhere.mock.calls
      .map(([, parameters]) => parameters)
      .filter(Boolean);

    expect(whereSql).toContain('core."personPhoneLookup" lookup');
    expect(whereSql).toContain('"canonicalPhone" = :canonicalPhone');
    expect(whereSql).toContain('"activeProjectionGeneration"');
    expect(whereSql).not.toMatch(/\bI?LIKE\b/i);
    expect(whereSql).not.toMatch(/to_tsquery|tsvector/);
    expect(queryParameters).toContainEqual(
      expect.objectContaining({
        canonicalPhone: '14155551500',
        readyFieldIds: ['readable'],
      }),
    );
    expect(queryBuilder.getRawMany).toHaveBeenCalledTimes(1);
  });
});
