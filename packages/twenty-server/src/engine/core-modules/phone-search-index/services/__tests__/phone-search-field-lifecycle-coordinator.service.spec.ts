import { PhoneSearchFieldLifecycleCoordinatorService } from 'src/engine/core-modules/phone-search-index/services/phone-search-field-lifecycle-coordinator.service';
import { STANDARD_OBJECTS } from 'twenty-shared/metadata';
import { FieldMetadataType } from 'twenty-shared/types';

describe('PhoneSearchFieldLifecycleCoordinatorService', () => {
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
          type: 'PHONES',
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
      type: 'PHONES',
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
          type: 'TEXT',
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
});
