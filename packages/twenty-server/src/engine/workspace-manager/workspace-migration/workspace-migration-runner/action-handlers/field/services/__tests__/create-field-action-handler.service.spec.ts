import { TWENTY_STANDARD_APPLICATION_UNIVERSAL_IDENTIFIER } from 'twenty-shared/application';
import { FieldMetadataType } from 'twenty-shared/types';

import { createEmptyFlatEntityMaps } from 'src/engine/metadata-modules/flat-entity/constant/create-empty-flat-entity-maps.constant';
import { addFlatEntityToFlatEntityMapsOrThrow } from 'src/engine/metadata-modules/flat-entity/utils/add-flat-entity-to-flat-entity-maps-or-throw.util';
import { getFlatFieldMetadataMock } from 'src/engine/metadata-modules/flat-field-metadata/__mocks__/get-flat-field-metadata.mock';
import { type FlatFieldMetadata } from 'src/engine/metadata-modules/flat-field-metadata/types/flat-field-metadata.type';
import { getFlatObjectMetadataMock } from 'src/engine/metadata-modules/flat-object-metadata/__mocks__/get-flat-object-metadata.mock';
import { CreateFieldActionHandlerService } from 'src/engine/workspace-manager/workspace-migration/workspace-migration-runner/action-handlers/field/services/create-field-action-handler.service';

const personObject = getFlatObjectMetadataMock({
  universalIdentifier: 'person-object',
  nameSingular: 'person',
  namePlural: 'people',
});

const flatObjectMetadataMaps = addFlatEntityToFlatEntityMapsOrThrow({
  flatEntity: personObject,
  flatEntityMaps: createEmptyFlatEntityMaps(),
});

const customField = getFlatFieldMetadataMock({
  universalIdentifier: 'tier-field',
  objectMetadataId: personObject.id,
  type: FieldMetadataType.TEXT,
  name: 'tier',
});

const standardField = getFlatFieldMetadataMock({
  universalIdentifier: 'job-title-field',
  objectMetadataId: personObject.id,
  type: FieldMetadataType.TEXT,
  name: 'jobTitle',
  applicationUniversalIdentifier:
    TWENTY_STANDARD_APPLICATION_UNIVERSAL_IDENTIFIER,
});

const createField = async (
  field: FlatFieldMetadata,
  usedColumnCount: number,
) => {
  const columnManager = {
    countColumns: jest.fn().mockResolvedValue(usedColumnCount),
    addColumns: jest.fn(),
  };
  const handler = new CreateFieldActionHandlerService({
    columnManager,
  } as never);

  const result = handler.executeForWorkspaceSchema({
    flatAction: { flatEntity: field, relatedFlatFieldMetadata: undefined },
    queryRunner: {},
    allFlatEntityMaps: { flatObjectMetadataMaps },
    workspaceId: '20202020-0000-0000-0000-000000000001',
  } as never);

  return { result, columnManager };
};

describe('CreateFieldActionHandlerService column limit', () => {
  it('refuses a custom field when the table has no room left', async () => {
    const { result, columnManager } = await createField(customField, 1500);

    await expect(result).rejects.toMatchObject({ code: 'TOO_MANY_COLUMNS' });
    expect(columnManager.addColumns).not.toHaveBeenCalled();
  });

  it('adds a custom field when the table has room', async () => {
    const { result, columnManager } = await createField(customField, 100);

    await result;
    expect(columnManager.addColumns).toHaveBeenCalledTimes(1);
  });

  it('never limits a standard field, so Twenty upgrades always have room', async () => {
    const { result, columnManager } = await createField(standardField, 1599);

    await result;
    expect(columnManager.countColumns).not.toHaveBeenCalled();
    expect(columnManager.addColumns).toHaveBeenCalledTimes(1);
  });
});
