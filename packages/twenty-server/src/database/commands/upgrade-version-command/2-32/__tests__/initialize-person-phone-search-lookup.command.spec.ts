import { STANDARD_OBJECTS } from 'twenty-shared/metadata';
import { FieldMetadataType } from 'twenty-shared/types';

import { InitializePersonPhoneSearchLookupCommand } from 'src/database/commands/upgrade-version-command/2-32/2-32-workspace-command-1786800001000-initialize-person-phone-search-lookup.command';
import { PhoneSearchFieldLifecycleCoordinatorService } from 'src/engine/core-modules/phone-search-index/services/phone-search-field-lifecycle-coordinator.service';

describe('InitializePersonPhoneSearchLookupCommand', () => {
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
                id: 'field',
                universalIdentifier: 'field-universal-id',
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
});
