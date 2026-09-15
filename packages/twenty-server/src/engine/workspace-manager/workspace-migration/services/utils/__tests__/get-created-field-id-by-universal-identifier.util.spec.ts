import { getCreatedFieldIdByUniversalIdentifier } from 'src/engine/workspace-manager/workspace-migration/services/utils/get-created-field-id-by-universal-identifier.util';
import { type WorkspaceMigration } from 'src/engine/workspace-manager/workspace-migration/workspace-migration-builder/types/workspace-migration.type';

describe('getCreatedFieldIdByUniversalIdentifier', () => {
  it('collects direct, related, and object-embedded field ids', () => {
    const workspaceMigration = {
      actions: [
        {
          type: 'create',
          metadataName: 'fieldMetadata',
          id: 'direct-id',
          flatEntity: { universalIdentifier: 'direct-field' },
          relatedFieldId: 'related-id',
          relatedUniversalFlatFieldMetadata: {
            universalIdentifier: 'related-field',
          },
        },
        {
          type: 'create',
          metadataName: 'objectMetadata',
          flatEntity: { universalIdentifier: 'object' },
          fieldIdByUniversalIdentifier: {
            'embedded-phone-field': 'embedded-id',
          },
          universalFlatFieldMetadatas: [],
        },
      ],
    } as unknown as WorkspaceMigration;

    expect(
      Object.fromEntries(
        getCreatedFieldIdByUniversalIdentifier(workspaceMigration),
      ),
    ).toEqual({
      'direct-field': 'direct-id',
      'related-field': 'related-id',
      'embedded-phone-field': 'embedded-id',
    });
  });
});
