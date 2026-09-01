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
  it('queries only exact readable field-qualified lexemes and never builds LIKE/ILIKE fallback SQL', async () => {
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

    await service.searchPeopleByPhone({
      workspace: { id: 'workspace' } as never,
      args: { phoneNumber: '+14155551500', limit: 10 },
      flatObjectMetadataMaps: {
        byUniversalIdentifier: {
          person: {
            id: 'person-object',
            nameSingular: 'person',
            fieldIds: ['readable', 'restricted'],
            fieldUniversalIdentifiers: [
              readableUniversalIdentifier,
              restrictedUniversalIdentifier,
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
        },
        universalIdentifierById: {
          readable: readableUniversalIdentifier,
          restricted: restrictedUniversalIdentifier,
        },
      } as never,
    });

    const whereSql = andWhere.mock.calls.map(([sql]) => String(sql)).join('\n');
    const queryParameters = andWhere.mock.calls
      .map(([, parameters]) => parameters)
      .filter(Boolean);

    expect(whereSql).toContain(
      '"phoneSearchVector" @@ to_tsquery(\'simple\', :qualifiedPhoneQuery)',
    );
    expect(whereSql).not.toMatch(/\bI?LIKE\b/i);
    expect(queryParameters).toContainEqual({
      qualifiedPhoneQuery: `f${readableUniversalIdentifier.replace(/-/g, '')}p14155551500`,
    });
    expect(JSON.stringify(queryParameters)).not.toContain(
      restrictedUniversalIdentifier.replace(/-/g, ''),
    );
    expect(queryBuilder.getRawMany).toHaveBeenCalledTimes(1);
  });
});
