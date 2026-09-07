import { PhoneSearchFieldLifecycleCoordinatorService } from 'src/engine/core-modules/phone-search-index/services/phone-search-field-lifecycle-coordinator.service';
import { STANDARD_OBJECTS } from 'twenty-shared/metadata';
import { FieldMetadataType } from 'twenty-shared/types';

describe('PhoneSearchFieldLifecycleCoordinatorService', () => {
  it('does not query lifecycle tables for a pre-2.32 PHONES metadata delta', async () => {
    const lifecycle = { create: jest.fn() };
    const gate = {
      isInfrastructureAvailable: jest.fn().mockResolvedValue(false),
    };
    const coordinator = new PhoneSearchFieldLifecycleCoordinatorService(
      lifecycle as never,
      { add: jest.fn() } as never,
      gate as never,
    );

    await expect(
      coordinator.afterMigration({
        workspaceId: 'w',
        objectMetadataId: 'p',
        updated: [],
        deleted: [],
        created: [
          {
            id: 'f',
            type: FieldMetadataType.PHONES,
            objectMetadataUniversalIdentifier:
              STANDARD_OBJECTS.person.universalIdentifier,
          },
        ],
      }),
    ).resolves.toEqual([]);
    expect(lifecycle.create).not.toHaveBeenCalled();
  });

  it('enqueues a purge only after its deleting transition commits', async () => {
    const lifecycle = {
      create: jest.fn(),
      rename: jest.fn(),
      setActive: jest.fn(),
      markDeleting: jest.fn().mockResolvedValue('operation'),
    };
    const queue = { add: jest.fn().mockResolvedValue(undefined) };
    const coordinator = new PhoneSearchFieldLifecycleCoordinatorService(
      lifecycle as never,
      queue as never,
    );
    await coordinator.afterMigration({
      workspaceId: 'w',
      objectMetadataId: 'p',
      created: [],
      updated: [],
      deleted: [
        {
          id: 'f',
          type: FieldMetadataType.PHONES,
          objectMetadataUniversalIdentifier:
            STANDARD_OBJECTS.person.universalIdentifier,
        },
      ],
    });
    expect(lifecycle.markDeleting).toHaveBeenCalled();
    expect(queue.add).toHaveBeenCalledWith('PhoneSearchIndexJob', {
      operationId: 'operation',
    });
  });

  it('does not write lifecycle state for an unchanged phone update', async () => {
    const lifecycle = {
      create: jest.fn(),
      rename: jest.fn(),
      setActive: jest.fn(),
      markDeleting: jest.fn(),
    };
    const coordinator = new PhoneSearchFieldLifecycleCoordinatorService(
      lifecycle as never,
      { add: jest.fn() } as never,
    );
    const field = {
      id: 'f',
      universalIdentifier: 'field-universal-id',
      type: FieldMetadataType.PHONES,
      name: 'phone',
      isActive: true,
      objectMetadataUniversalIdentifier:
        STANDARD_OBJECTS.person.universalIdentifier,
    };
    await coordinator.afterMigration({
      workspaceId: 'w',
      objectMetadataId: 'p',
      created: [],
      updated: [{ ...field, before: field }],
      deleted: [],
    });
    expect(lifecycle.rename).not.toHaveBeenCalled();
    expect(lifecycle.setActive).not.toHaveBeenCalled();
  });

  it('queues an add-field backfill only after the durable lifecycle transition', async () => {
    const lifecycle = {
      create: jest.fn().mockResolvedValue('operation'),
      rename: jest.fn(),
      setActive: jest.fn(),
      markDeleting: jest.fn(),
    };
    const queue = { add: jest.fn().mockResolvedValue(undefined) };
    const coordinator = new PhoneSearchFieldLifecycleCoordinatorService(
      lifecycle as never,
      queue as never,
    );
    await coordinator.afterMigration({
      workspaceId: 'w',
      objectMetadataId: 'p',
      updated: [],
      deleted: [],
      created: [
        {
          id: 'f',
          universalIdentifier: 'u',
          name: 'mobile',
          isActive: true,
          type: FieldMetadataType.PHONES,
          objectMetadataUniversalIdentifier:
            STANDARD_OBJECTS.person.universalIdentifier,
        },
      ],
    });
    expect(queue.add).toHaveBeenCalledWith('PhoneSearchIndexJob', {
      operationId: 'operation',
    });
  });

  it('coalesces several created phone fields into one queue delivery', async () => {
    const lifecycle = {
      create: jest.fn().mockResolvedValue('shared-operation'),
      rename: jest.fn(),
      setActive: jest.fn(),
      markDeleting: jest.fn(),
    };
    const queue = { add: jest.fn().mockResolvedValue(undefined) };
    const coordinator = new PhoneSearchFieldLifecycleCoordinatorService(
      lifecycle as never,
      queue as never,
    );
    const baseField = {
      type: FieldMetadataType.PHONES,
      isActive: true,
      objectMetadataUniversalIdentifier:
        STANDARD_OBJECTS.person.universalIdentifier,
    };

    expect(
      await coordinator.afterMigration({
        workspaceId: 'w',
        objectMetadataId: 'p',
        updated: [],
        deleted: [],
        created: [
          {
            ...baseField,
            id: 'first',
            universalIdentifier: 'first-u',
            name: 'firstPhone',
          },
          {
            ...baseField,
            id: 'second',
            universalIdentifier: 'second-u',
            name: 'secondPhone',
          },
        ],
      }),
    ).toEqual(['shared-operation']);
    expect(lifecycle.create).toHaveBeenCalledTimes(2);
    expect(queue.add).toHaveBeenCalledTimes(1);
  });

  it('does nothing for non-Person or non-phone fields', async () => {
    const lifecycle = {
      create: jest.fn(),
      rename: jest.fn(),
      setActive: jest.fn(),
      markDeleting: jest.fn(),
    };
    const queue = { add: jest.fn() };
    const coordinator = new PhoneSearchFieldLifecycleCoordinatorService(
      lifecycle as never,
      queue as never,
    );
    await coordinator.afterMigration({
      workspaceId: 'w',
      objectMetadataId: 'o',
      updated: [],
      deleted: [],
      created: [
        {
          id: 'f',
          type: FieldMetadataType.TEXT,
          objectMetadataUniversalIdentifier:
            STANDARD_OBJECTS.person.universalIdentifier,
        },
        {
          id: 'g',
          type: FieldMetadataType.PHONES,
          objectMetadataUniversalIdentifier: 'not-person',
        },
      ],
    });
    expect(lifecycle.create).not.toHaveBeenCalled();
    expect(queue.add).not.toHaveBeenCalled();
  });

  it('treats post-commit queue rejection as recoverable durable delivery', async () => {
    const coordinator = new PhoneSearchFieldLifecycleCoordinatorService(
      {} as never,
      {
        add: jest.fn().mockRejectedValue(new Error('redis unavailable')),
      } as never,
    );

    await expect(
      coordinator.enqueue(['durable-operation']),
    ).resolves.toBeUndefined();
  });

  it('rejects an unresolved created phone field id before lifecycle SQL', async () => {
    const lifecycle = { create: jest.fn() };
    const coordinator = new PhoneSearchFieldLifecycleCoordinatorService(
      lifecycle as never,
      { add: jest.fn() } as never,
    );

    await expect(
      coordinator.afterMigration({
        workspaceId: 'workspace',
        objectMetadataId: 'person',
        updated: [],
        deleted: [],
        created: [
          {
            universalIdentifier: 'field-universal-id',
            name: 'phones',
            isActive: true,
            type: FieldMetadataType.PHONES,
            objectMetadataUniversalIdentifier:
              STANDARD_OBJECTS.person.universalIdentifier,
          },
        ],
      }),
    ).rejects.toThrow('Phone-search lifecycle field metadata is incomplete');
    expect(lifecycle.create).not.toHaveBeenCalled();
  });
});
