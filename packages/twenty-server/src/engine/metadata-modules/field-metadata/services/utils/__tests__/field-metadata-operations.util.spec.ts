import { FieldMetadataException } from 'src/engine/metadata-modules/field-metadata/field-metadata.exception';
import {
  type FieldUpdateTranspilation,
  mergeIndependentFieldOperations,
  toFieldCreateOperations,
  toFieldUpdateOperations,
} from 'src/engine/metadata-modules/field-metadata/services/utils/field-metadata-operations.util';

const entity = (universalIdentifier: string) =>
  ({ universalIdentifier }) as never;

const emptyUpdateTranspilation = (): FieldUpdateTranspilation =>
  ({
    flatFieldMetadatasToUpdate: [],
    flatFieldMetadatasToCreate: [],
    flatIndexMetadatasToUpdate: [],
    flatIndexMetadatasToDelete: [],
    flatIndexMetadatasToCreate: [],
    flatViewGroupsToCreate: [],
    flatViewGroupsToDelete: [],
    flatViewGroupsToUpdate: [],
    flatViewFiltersToDelete: [],
    flatViewFiltersToUpdate: [],
    flatViewFieldsToDelete: [],
    flatViewsToUpdate: [],
    flatViewsToDelete: [],
  }) as FieldUpdateTranspilation;

describe('mergeIndependentFieldOperations', () => {
  it('runs creates and settings updates of different fields as one set of operations', () => {
    const merged = mergeIndependentFieldOperations([
      toFieldCreateOperations({
        flatFieldMetadatasToCreate: [entity('new-field')],
        flatIndexMetadatasToCreate: [entity('new-index')],
      }),
      toFieldUpdateOperations({
        ...emptyUpdateTranspilation(),
        flatFieldMetadatasToUpdate: [entity('company-linkedin')],
      }),
      toFieldUpdateOperations({
        ...emptyUpdateTranspilation(),
        flatFieldMetadatasToUpdate: [entity('person-linkedin')],
        flatViewsToUpdate: [entity('person-view')],
      }),
    ]);

    expect(merged.fieldMetadata.flatEntityToCreate).toEqual([
      entity('new-field'),
    ]);
    expect(merged.fieldMetadata.flatEntityToUpdate).toEqual([
      entity('company-linkedin'),
      entity('person-linkedin'),
    ]);
    expect(merged.index.flatEntityToCreate).toEqual([entity('new-index')]);
    expect(merged.view.flatEntityToUpdate).toEqual([entity('person-view')]);
  });

  it('refuses two updates of the same field', () => {
    expect(() =>
      mergeIndependentFieldOperations([
        toFieldUpdateOperations({
          ...emptyUpdateTranspilation(),
          flatFieldMetadatasToUpdate: [entity('company-linkedin')],
        }),
        toFieldUpdateOperations({
          ...emptyUpdateTranspilation(),
          flatFieldMetadatasToUpdate: [entity('company-linkedin')],
        }),
      ]),
    ).toThrow(FieldMetadataException);
  });

  it('refuses two updates that both change the same view', () => {
    expect(() =>
      mergeIndependentFieldOperations([
        toFieldUpdateOperations({
          ...emptyUpdateTranspilation(),
          flatFieldMetadatasToUpdate: [entity('field-a')],
          flatViewsToUpdate: [entity('shared-view')],
        }),
        toFieldUpdateOperations({
          ...emptyUpdateTranspilation(),
          flatFieldMetadatasToUpdate: [entity('field-b')],
          flatViewsToDelete: [entity('shared-view')],
        }),
      ]),
    ).toThrow(/view shared-view is changed more than once/);
  });

  it('allows the same identifier under different metadata types', () => {
    expect(() =>
      mergeIndependentFieldOperations([
        toFieldCreateOperations({
          flatFieldMetadatasToCreate: [entity('same-id')],
          flatIndexMetadatasToCreate: [entity('same-id')],
        }),
      ]),
    ).not.toThrow();
  });
});
