import { FieldMetadataType } from 'twenty-shared/types';

import { computeFlatFieldToUpdateAndRelatedFlatFieldToUpdate } from 'src/engine/metadata-modules/flat-field-metadata/utils/compute-flat-field-to-update-and-related-flat-field-to-update.util';

const marker = {
  version: 1 as const,
  target: 'person' as const,
  format: 'plain' as const,
  searchable: true,
};

describe('Regie marker settings updates', () => {
  it.each([FieldMetadataType.SELECT, FieldMetadataType.MULTI_SELECT])(
    'merges marker and sibling settings for %s updates',
    (type) => {
      const fromFlatFieldMetadata = {
        id: 'field-id',
        universalIdentifier: 'field-uid',
        type,
        isCustom: true,
        settings: {
          twentyOwnedSibling: 'retain',
          regieCustomField: marker,
        },
      };

      const result = computeFlatFieldToUpdateAndRelatedFlatFieldToUpdate({
        fromFlatFieldMetadata: fromFlatFieldMetadata as never,
        rawUpdateFieldInput: {
          id: 'field-id',
          settings: { twentyOwnedSibling: 'updated' },
        } as never,
        flatFieldMetadataMaps: {} as never,
        flatObjectMetadata: {} as never,
        isSystemBuild: false,
      });

      expect(
        result.flatFieldMetadataFromTo.toFlatFieldMetadata.settings,
      ).toEqual({
        twentyOwnedSibling: 'updated',
        regieCustomField: marker,
      });
      expect(
        result.flatFieldMetadataFromTo.toFlatFieldMetadata.universalSettings,
      ).toEqual({
        twentyOwnedSibling: 'updated',
        regieCustomField: marker,
      });
    },
  );
});
