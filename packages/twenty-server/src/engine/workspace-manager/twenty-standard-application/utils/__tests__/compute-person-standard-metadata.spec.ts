import { STANDARD_OBJECTS } from 'twenty-shared/metadata';

import { IndexType } from 'src/engine/metadata-modules/index-metadata/types/indexType.types';
import { computeTwentyStandardApplicationAllFlatEntityMaps } from 'src/engine/workspace-manager/twenty-standard-application/utils/twenty-standard-application-all-flat-entity-maps.constant';
import { computeFlatIndexFieldColumnNames } from 'src/engine/workspace-manager/workspace-migration/workspace-migration-runner/action-handlers/index/utils/index-action-handler.utils';

const WORKSPACE_ID = '20202020-1111-4111-8111-111111111111';
const TWENTY_STANDARD_APPLICATION_ID = '20202020-2222-4222-8222-222222222222';
const NOW = '2024-01-01T00:00:00.000Z';

describe('Person standard metadata build', () => {
  const { allFlatEntityMaps } =
    computeTwentyStandardApplicationAllFlatEntityMaps({
      now: NOW,
      workspaceId: WORKSPACE_ID,
      twentyStandardApplicationId: TWENTY_STANDARD_APPLICATION_ID,
    });

  it('should index the primary phone number as one non-unique BTREE column', () => {
    const phoneIndex =
      allFlatEntityMaps.flatIndexMaps.byUniversalIdentifier[
        STANDARD_OBJECTS.person.indexes.phonesPrimaryPhoneNumberIndex
          .universalIdentifier
      ];
    const phonesField =
      allFlatEntityMaps.flatFieldMetadataMaps.byUniversalIdentifier[
        STANDARD_OBJECTS.person.fields.phones.universalIdentifier
      ];

    expect(phoneIndex).toMatchObject({
      indexType: IndexType.BTREE,
      indexWhereClause: null,
      isCustom: false,
      isSystemSideEffect: true,
      isUnique: false,
      name: 'IDX_339a60adc1b5331032780e18168',
    });
    expect(phoneIndex?.flatIndexFieldMetadatas).toEqual([
      expect.objectContaining({
        fieldMetadataId: phonesField?.id,
        order: 0,
        subFieldName: 'primaryPhoneNumber',
      }),
    ]);
    expect(phoneIndex?.universalFlatIndexFieldMetadatas).toEqual([
      expect.objectContaining({
        fieldMetadataUniversalIdentifier:
          STANDARD_OBJECTS.person.fields.phones.universalIdentifier,
        order: 0,
        subFieldName: 'primaryPhoneNumber',
      }),
    ]);
    expect(
      computeFlatIndexFieldColumnNames({
        flatIndexFieldMetadatas: phoneIndex?.flatIndexFieldMetadatas ?? [],
        flatFieldMetadataMaps: allFlatEntityMaps.flatFieldMetadataMaps,
      }),
    ).toEqual(['phonesPrimaryPhoneNumber']);
  });
});
