import { STANDARD_OBJECTS } from 'twenty-shared/metadata';
import { FieldMetadataType } from 'twenty-shared/types';

import { InitializePersonPhoneSearchLookupCommand } from 'src/database/commands/upgrade-version-command/2-32/2-32-workspace-command-1786800001000-initialize-person-phone-search-lookup.command';
import { PhoneSearchFieldLifecycleCoordinatorService } from 'src/engine/core-modules/phone-search-index/services/phone-search-field-lifecycle-coordinator.service';

describe('InitializePersonPhoneSearchLookupCommand', () => {
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
          phone: {
            id: '00000000-0000-0000-0000-000000000001',
            universalIdentifier: '00000000-0000-0000-0000-000000000002',
            objectMetadataUniversalIdentifier:
              STANDARD_OBJECTS.person.universalIdentifier,
            name: 'phones',
            isActive: true,
            type: FieldMetadataType.PHONES,
          },
          secondaryPhone: {
            id: '00000000-0000-0000-0000-000000000003',
            universalIdentifier: '00000000-0000-0000-0000-000000000004',
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

  it('commits durable work and tolerates post-commit Redis failure', async () => {
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
        if (sql.includes('FROM core."phoneSearchFieldState"')) return [];
        if (sql.includes('SELECT id FROM core."phoneSearchIndexOperation"'))
          return [];
        if (sql.includes('RETURNING id')) return [{ id: 'operation' }];
        return [];
      }),
    };
    const queue = {
      add: jest.fn().mockRejectedValue(new Error('redis unavailable')),
    };
    const coordinator = new PhoneSearchFieldLifecycleCoordinatorService(
      {} as never,
      queue as never,
    );
    const command = new InitializePersonPhoneSearchLookupCommand(
      {} as never,
      workspaceCacheService as never,
      { createQueryRunner: jest.fn().mockReturnValue(runner) } as never,
      { install: jest.fn() } as never,
      coordinator,
    );

    await expect(
      command.runOnWorkspace({
        workspaceId: 'workspace',
        index: 0,
        total: 1,
        options: { dryRun: false } as never,
      }),
    ).resolves.toBeUndefined();
    expect(runner.commitTransaction).toHaveBeenCalledTimes(1);
    expect(queue.add).toHaveBeenCalledWith('PhoneSearchIndexJob', {
      operationId: 'operation',
    });
    expect(runner.commitTransaction.mock.invocationCallOrder[0]).toBeLessThan(
      queue.add.mock.invocationCallOrder[0]!,
    );
  });

  it('does not enqueue another initialization when every phone field is ready', async () => {
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
        if (sql.includes('FROM core."phoneSearchFieldState"'))
          return [
            { fieldMetadataId: '00000000-0000-0000-0000-000000000001' },
            { fieldMetadataId: '00000000-0000-0000-0000-000000000003' },
          ];
        return [];
      }),
    };
    const coordinator = {
      enqueue: jest.fn(),
    };
    const triggerManager = {
      install: jest.fn(),
    };
    const command = new InitializePersonPhoneSearchLookupCommand(
      {} as never,
      workspaceCacheService as never,
      { createQueryRunner: jest.fn().mockReturnValue(runner) } as never,
      triggerManager as never,
      coordinator as never,
    );

    await command.runOnWorkspace({
      workspaceId: 'workspace',
      index: 0,
      total: 1,
      options: { dryRun: false } as never,
    });

    expect(triggerManager.install).toHaveBeenCalledTimes(1);
    expect(runner.commitTransaction).toHaveBeenCalledTimes(1);
    expect(runner.query).not.toHaveBeenCalledWith(
      expect.stringContaining('phoneSearchIndexOperation" ('),
      expect.anything(),
    );
    expect(coordinator.enqueue).not.toHaveBeenCalled();
  });

  it('continues initialization when any phone field is not ready', async () => {
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
        if (sql.includes('FROM core."phoneSearchFieldState"'))
          return [{ fieldMetadataId: '00000000-0000-0000-0000-000000000001' }];
        if (sql.includes('SELECT id FROM core."phoneSearchIndexOperation"'))
          return [];
        if (sql.includes('RETURNING id')) return [{ id: 'operation' }];
        return [];
      }),
    };
    const coordinator = {
      enqueue: jest.fn(),
    };
    const command = new InitializePersonPhoneSearchLookupCommand(
      {} as never,
      workspaceCacheService as never,
      { createQueryRunner: jest.fn().mockReturnValue(runner) } as never,
      { install: jest.fn() } as never,
      coordinator as never,
    );

    await command.runOnWorkspace({
      workspaceId: 'workspace',
      index: 0,
      total: 1,
      options: { dryRun: false } as never,
    });

    expect(coordinator.enqueue).toHaveBeenCalledWith(['operation']);
  });
});
