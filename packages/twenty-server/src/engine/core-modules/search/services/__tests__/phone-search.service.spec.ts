import { FieldMetadataType } from 'twenty-shared/types';

import { PhoneSearchService } from 'src/engine/core-modules/search/services/phone-search.service';
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
      createQueryBuilder: jest.fn().mockReturnValue(queryBuilder),
    };
    const manager = {
      executeInWorkspaceContext: jest
        .fn()
        .mockImplementation((callback: () => unknown) => callback()),
      getRepository: jest.fn().mockResolvedValue(repository),
    };
    const service = new PhoneSearchService(
      manager as unknown as GlobalWorkspaceOrmManager,
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
