import { STANDARD_OBJECTS } from 'twenty-shared/metadata';
import { FieldMetadataType } from 'twenty-shared/types';

import { ReconcilePersonPhoneSearchStateCommand } from 'src/database/commands/upgrade-version-command/2-32/2-32-workspace-command-1789454114932-reconcile-person-phone-search-state.command';

const FIRST_FIELD_ID = '00000000-0000-0000-0000-000000000001';
const SECOND_FIELD_ID = '00000000-0000-0000-0000-000000000002';

describe('ReconcilePersonPhoneSearchStateCommand', () => {
  const workspaceCacheService = {
    getOrRecompute: jest.fn().mockResolvedValue({
      flatObjectMetadataMaps: {
        byUniversalIdentifier: {
          [STANDARD_OBJECTS.person.universalIdentifier]: {
            id: 'person-object',
            universalIdentifier: STANDARD_OBJECTS.person.universalIdentifier,
          },
        },
      },
      flatFieldMetadataMaps: {
        byUniversalIdentifier: {
          firstPhone: {
            id: FIRST_FIELD_ID,
            universalIdentifier: '00000000-0000-0000-0000-000000000011',
            objectMetadataUniversalIdentifier:
              STANDARD_OBJECTS.person.universalIdentifier,
            name: 'phones',
            isActive: true,
            type: FieldMetadataType.PHONES,
          },
          secondPhone: {
            id: SECOND_FIELD_ID,
            universalIdentifier: '00000000-0000-0000-0000-000000000012',
            objectMetadataUniversalIdentifier:
              STANDARD_OBJECTS.person.universalIdentifier,
            name: 'secondaryPhones',
            isActive: true,
            type: FieldMetadataType.PHONES,
          },
        },
      },
    }),
  };

  it('creates state only for fields missing it', async () => {
    const triggerManager = { install: jest.fn() };
    const lifecycleCoordinator = { afterMigration: jest.fn() };
    const command = new ReconcilePersonPhoneSearchStateCommand(
      {} as never,
      workspaceCacheService as never,
      {
        query: jest.fn().mockResolvedValue([
          {
            fieldMetadataId: FIRST_FIELD_ID,
          },
        ]),
      } as never,
      triggerManager as never,
      lifecycleCoordinator as never,
    );

    await command.runOnWorkspace({
      workspaceId: 'workspace',
      index: 0,
      total: 1,
      options: { dryRun: false } as never,
    });

    expect(triggerManager.install).toHaveBeenCalledWith({
      workspaceId: 'workspace',
      objectMetadataId: 'person-object',
    });
    expect(lifecycleCoordinator.afterMigration).toHaveBeenCalledWith({
      workspaceId: 'workspace',
      objectMetadataId: 'person-object',
      created: [expect.objectContaining({ id: SECOND_FIELD_ID })],
      updated: [],
      deleted: [],
    });
  });

  it('does not touch the trigger or lifecycle when every field has state', async () => {
    const triggerManager = { install: jest.fn() };
    const lifecycleCoordinator = { afterMigration: jest.fn() };
    const command = new ReconcilePersonPhoneSearchStateCommand(
      {} as never,
      workspaceCacheService as never,
      {
        query: jest.fn().mockResolvedValue([
          { fieldMetadataId: FIRST_FIELD_ID },
          { fieldMetadataId: SECOND_FIELD_ID },
        ]),
      } as never,
      triggerManager as never,
      lifecycleCoordinator as never,
    );

    await command.runOnWorkspace({
      workspaceId: 'workspace',
      index: 0,
      total: 1,
      options: { dryRun: false } as never,
    });

    expect(triggerManager.install).not.toHaveBeenCalled();
    expect(lifecycleCoordinator.afterMigration).not.toHaveBeenCalled();
  });
});
