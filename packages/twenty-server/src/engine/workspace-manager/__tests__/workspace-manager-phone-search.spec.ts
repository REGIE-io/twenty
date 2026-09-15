import { STANDARD_OBJECTS } from 'twenty-shared/metadata';
import { FieldMetadataType } from 'twenty-shared/types';

import { WorkspaceManagerService } from 'src/engine/workspace-manager/workspace-manager.service';

describe('WorkspaceManagerService phone-search initialization', () => {
  it('installs the Person trigger and creates durable phone state before initialization completes', async () => {
    const synchronize = jest.fn().mockResolvedValue({
      workspaceCustomFlatApplication: { id: 'application' },
    });
    const install = jest.fn().mockResolvedValue(undefined);
    const initializePhoneFields = jest.fn().mockResolvedValue(['operation']);
    const setupRoleLookup = jest
      .fn()
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce({ id: 'member-role' });
    const workspaceRepository = { update: jest.fn() };
    const service = new WorkspaceManagerService(
      {
        createWorkspaceDBSchema: jest
          .fn()
          .mockResolvedValue('workspace_schema'),
      } as never,
      { findOneOrFail: jest.fn() } as never,
      { createMemberRole: jest.fn() } as never,
      { assignRoleToManyUserWorkspace: jest.fn() } as never,
      { synchronizeTwentyStandardApplicationOrThrow: synchronize } as never,
      workspaceRepository as never,
      { findOne: setupRoleLookup } as never,
      { createTwentyStandardApplication: jest.fn() } as never,
      {
        getOrRecompute: jest.fn().mockResolvedValue({
          flatObjectMetadataMaps: {
            byUniversalIdentifier: {
              [STANDARD_OBJECTS.person.universalIdentifier]: {
                id: 'person-object',
                universalIdentifier:
                  STANDARD_OBJECTS.person.universalIdentifier,
              },
            },
          },
          flatFieldMetadataMaps: {
            byUniversalIdentifier: {
              phone: {
                id: 'phone-field',
                universalIdentifier: 'phone-field-universal-identifier',
                objectMetadataUniversalIdentifier:
                  STANDARD_OBJECTS.person.universalIdentifier,
                name: 'phones',
                isActive: true,
                type: FieldMetadataType.PHONES,
              },
            },
          },
        }),
      } as never,
      { install } as never,
      { afterMigration: initializePhoneFields } as never,
    );

    await service.init({
      workspace: { id: 'workspace' } as never,
      userId: 'user',
    });

    expect(install).toHaveBeenCalledWith({
      workspaceId: 'workspace',
      objectMetadataId: 'person-object',
    });
    expect(initializePhoneFields).toHaveBeenCalledWith({
      workspaceId: 'workspace',
      objectMetadataId: 'person-object',
      created: [
        expect.objectContaining({
          id: 'phone-field',
          type: FieldMetadataType.PHONES,
        }),
      ],
      updated: [],
      deleted: [],
    });
    expect(synchronize.mock.invocationCallOrder[0]).toBeLessThan(
      install.mock.invocationCallOrder[0]!,
    );
    expect(install.mock.invocationCallOrder[0]).toBeLessThan(
      initializePhoneFields.mock.invocationCallOrder[0]!,
    );
    expect(initializePhoneFields.mock.invocationCallOrder[0]).toBeLessThan(
      setupRoleLookup.mock.invocationCallOrder[0]!,
    );
  });
});
