import {
  FieldMetadataException,
  FieldMetadataExceptionCode,
} from 'src/engine/metadata-modules/field-metadata/field-metadata.exception';
import { type fromUpdateFieldInputToFlatFieldMetadata } from 'src/engine/metadata-modules/flat-field-metadata/utils/from-update-field-input-to-flat-field-metadata.util';

export type FieldUpdateTranspilation = Extract<
  ReturnType<typeof fromUpdateFieldInputToFlatFieldMetadata>,
  { status: 'success' }
>['result'];

type FieldToChange =
  FieldUpdateTranspilation['flatFieldMetadatasToUpdate'][number];
type IndexToChange =
  FieldUpdateTranspilation['flatIndexMetadatasToCreate'][number];

type FlatEntityOperation<T> = {
  flatEntityToCreate: T[];
  flatEntityToDelete: T[];
  flatEntityToUpdate: T[];
};

export type FieldOperations = {
  fieldMetadata: FlatEntityOperation<FieldToChange>;
  index: FlatEntityOperation<IndexToChange>;
  viewFilter: FlatEntityOperation<
    FieldUpdateTranspilation['flatViewFiltersToUpdate'][number]
  >;
  viewGroup: FlatEntityOperation<
    FieldUpdateTranspilation['flatViewGroupsToCreate'][number]
  >;
  view: FlatEntityOperation<
    FieldUpdateTranspilation['flatViewsToUpdate'][number]
  >;
  viewField: FlatEntityOperation<
    FieldUpdateTranspilation['flatViewFieldsToDelete'][number]
  >;
};

const emptyOperation = <T>(): FlatEntityOperation<T> => ({
  flatEntityToCreate: [],
  flatEntityToDelete: [],
  flatEntityToUpdate: [],
});

const emptyFieldOperations = (): FieldOperations => ({
  fieldMetadata: emptyOperation(),
  index: emptyOperation(),
  viewFilter: emptyOperation(),
  viewGroup: emptyOperation(),
  view: emptyOperation(),
  viewField: emptyOperation(),
});

export const toFieldCreateOperations = ({
  flatFieldMetadatasToCreate,
  flatIndexMetadatasToCreate,
}: {
  flatFieldMetadatasToCreate: FieldToChange[];
  flatIndexMetadatasToCreate: IndexToChange[];
}): FieldOperations => ({
  ...emptyFieldOperations(),
  fieldMetadata: {
    ...emptyOperation(),
    flatEntityToCreate: flatFieldMetadatasToCreate,
  },
  index: {
    ...emptyOperation(),
    flatEntityToCreate: flatIndexMetadatasToCreate,
  },
});

export const toFieldUpdateOperations = (
  transpilation: FieldUpdateTranspilation,
): FieldOperations => ({
  fieldMetadata: {
    flatEntityToCreate: transpilation.flatFieldMetadatasToCreate,
    flatEntityToDelete: [],
    flatEntityToUpdate: transpilation.flatFieldMetadatasToUpdate,
  },
  index: {
    flatEntityToCreate: transpilation.flatIndexMetadatasToCreate,
    flatEntityToDelete: transpilation.flatIndexMetadatasToDelete,
    flatEntityToUpdate: transpilation.flatIndexMetadatasToUpdate,
  },
  viewFilter: {
    flatEntityToCreate: [],
    flatEntityToDelete: transpilation.flatViewFiltersToDelete,
    flatEntityToUpdate: transpilation.flatViewFiltersToUpdate,
  },
  viewGroup: {
    flatEntityToCreate: transpilation.flatViewGroupsToCreate,
    flatEntityToDelete: transpilation.flatViewGroupsToDelete,
    flatEntityToUpdate: transpilation.flatViewGroupsToUpdate,
  },
  view: {
    flatEntityToCreate: [],
    flatEntityToDelete: transpilation.flatViewsToDelete,
    flatEntityToUpdate: transpilation.flatViewsToUpdate,
  },
  viewField: {
    flatEntityToCreate: [],
    flatEntityToDelete: transpilation.flatViewFieldsToDelete,
    flatEntityToUpdate: [],
  },
});

// Each operation is transpiled against the same pre-change maps, so two of them touching
// one entity would silently overwrite each other in a single migration. Refuse instead.
export const mergeIndependentFieldOperations = (
  operationsList: FieldOperations[],
): FieldOperations => {
  const touchedEntityKeys = new Set<string>();

  for (const operations of operationsList) {
    for (const [metadataName, operation] of Object.entries(operations)) {
      const entities: { universalIdentifier: string }[] = [
        ...operation.flatEntityToCreate,
        ...operation.flatEntityToDelete,
        ...operation.flatEntityToUpdate,
      ];

      for (const { universalIdentifier } of entities) {
        const entityKey = `${metadataName}:${universalIdentifier}`;

        if (touchedEntityKeys.has(entityKey)) {
          throw new FieldMetadataException(
            `Field changes in one batch must be independent: ${metadataName} ${universalIdentifier} is changed more than once`,
            FieldMetadataExceptionCode.INVALID_FIELD_INPUT,
          );
        }

        touchedEntityKeys.add(entityKey);
      }
    }
  }

  return operationsList.reduce<FieldOperations>(
    (merged, operations) => ({
      fieldMetadata: mergeOperation(
        merged.fieldMetadata,
        operations.fieldMetadata,
      ),
      index: mergeOperation(merged.index, operations.index),
      viewFilter: mergeOperation(merged.viewFilter, operations.viewFilter),
      viewGroup: mergeOperation(merged.viewGroup, operations.viewGroup),
      view: mergeOperation(merged.view, operations.view),
      viewField: mergeOperation(merged.viewField, operations.viewField),
    }),
    emptyFieldOperations(),
  );
};

const mergeOperation = <T>(
  left: FlatEntityOperation<T>,
  right: FlatEntityOperation<T>,
): FlatEntityOperation<T> => ({
  flatEntityToCreate: [...left.flatEntityToCreate, ...right.flatEntityToCreate],
  flatEntityToDelete: [...left.flatEntityToDelete, ...right.flatEntityToDelete],
  flatEntityToUpdate: [...left.flatEntityToUpdate, ...right.flatEntityToUpdate],
});
