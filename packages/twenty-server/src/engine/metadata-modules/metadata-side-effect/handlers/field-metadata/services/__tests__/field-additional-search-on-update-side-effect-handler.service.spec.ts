import {
  FieldMetadataType,
  type AdditionalSearchMarker,
} from 'twenty-shared/types';

import { type FlatEntityMaps } from 'src/engine/metadata-modules/flat-entity/types/flat-entity-maps.type';
import { type MetadataUniversalFlatEntity } from 'src/engine/metadata-modules/flat-entity/types/metadata-universal-flat-entity.type';
import { getFlatFieldMetadataMock } from 'src/engine/metadata-modules/flat-field-metadata/__mocks__/get-flat-field-metadata.mock';
import { type FlatFieldMetadata } from 'src/engine/metadata-modules/flat-field-metadata/types/flat-field-metadata.type';
import { getFlatObjectMetadataMock } from 'src/engine/metadata-modules/flat-object-metadata/__mocks__/get-flat-object-metadata.mock';
import { FieldAdditionalSearchOnUpdateSideEffectHandlerService } from 'src/engine/metadata-modules/metadata-side-effect/handlers/field-metadata/services/field-additional-search-on-update-side-effect-handler.service';
import { type BuildSideEffectsArgs } from 'src/engine/metadata-modules/metadata-side-effect/interfaces/base-metadata-side-effect-handler.service';
import { SEARCH_VECTOR_FIELD } from 'src/engine/metadata-modules/search-field-metadata/constants/search-vector-field.constants';

// A real UUID: the deterministic identifier helpers use it as a v5 namespace.
const APPLICATION_UNIVERSAL_IDENTIFIER = '11111111-1111-4111-8111-111111111111';
const COMPANY_OBJECT_UNIVERSAL_IDENTIFIER =
  'company-object-universal-identifier';
const SEARCH_VECTOR_UNIVERSAL_IDENTIFIER = 'search-vector-universal-identifier';
const MARKED_FIELD_UNIVERSAL_IDENTIFIER = 'marked-field-universal-identifier';
const EXISTING_ROW_UNIVERSAL_IDENTIFIER = 'existing-search-row';

const marker: AdditionalSearchMarker = {
  version: 1,
  target: 'account',
  searchable: true,
};

const buildFlatFieldMetadataMaps = (
  flatFieldMetadatas: FlatFieldMetadata[],
): FlatEntityMaps<FlatFieldMetadata> => ({
  byUniversalIdentifier: Object.fromEntries(
    flatFieldMetadatas.map((flatFieldMetadata) => [
      flatFieldMetadata.universalIdentifier,
      flatFieldMetadata,
    ]),
  ),
  universalIdentifierById: {},
  universalIdentifiersByApplicationId: {},
});

const buildArgs = ({
  fieldOverrides = {},
  isRegistered = false,
}: {
  fieldOverrides?: Partial<FlatFieldMetadata>;
  isRegistered?: boolean;
} = {}): BuildSideEffectsArgs<'fieldMetadata'> => {
  const tsVectorFlatFieldMetadata = getFlatFieldMetadataMock({
    universalIdentifier: SEARCH_VECTOR_UNIVERSAL_IDENTIFIER,
    objectMetadataId: 'company-object-id',
    applicationUniversalIdentifier: APPLICATION_UNIVERSAL_IDENTIFIER,
    objectMetadataUniversalIdentifier: COMPANY_OBJECT_UNIVERSAL_IDENTIFIER,
    type: FieldMetadataType.TS_VECTOR,
    name: SEARCH_VECTOR_FIELD.name,
  });

  const flatObjectMetadata = getFlatObjectMetadataMock({
    id: 'company-object-id',
    universalIdentifier: COMPANY_OBJECT_UNIVERSAL_IDENTIFIER,
    applicationUniversalIdentifier: APPLICATION_UNIVERSAL_IDENTIFIER,
    nameSingular: 'company',
    fieldUniversalIdentifiers: [SEARCH_VECTOR_UNIVERSAL_IDENTIFIER],
  });

  const flatFieldMetadata = getFlatFieldMetadataMock({
    universalIdentifier: MARKED_FIELD_UNIVERSAL_IDENTIFIER,
    objectMetadataId: 'company-object-id',
    applicationUniversalIdentifier: APPLICATION_UNIVERSAL_IDENTIFIER,
    objectMetadataUniversalIdentifier: COMPANY_OBJECT_UNIVERSAL_IDENTIFIER,
    name: 'searchIntent',
    type: FieldMetadataType.SELECT,
    universalSettings: { additionalSearch: marker },
    searchFieldMetadataUniversalIdentifiers: isRegistered
      ? [EXISTING_ROW_UNIVERSAL_IDENTIFIER]
      : [],
    ...fieldOverrides,
  });

  return {
    flatEntity: flatFieldMetadata,
    allFlatEntityOperationRecordByMetadataName: {},
    relatedFlatEntityMaps: {
      flatFieldMetadataMaps: buildFlatFieldMetadataMaps([
        tsVectorFlatFieldMetadata,
        flatFieldMetadata,
      ]),
      flatObjectMetadataMaps: {
        byUniversalIdentifier: {
          [COMPANY_OBJECT_UNIVERSAL_IDENTIFIER]: flatObjectMetadata,
        },
        universalIdentifierById: {},
        universalIdentifiersByApplicationId: {},
      },
      flatSearchFieldMetadataMaps: {
        byUniversalIdentifier: {
          [EXISTING_ROW_UNIVERSAL_IDENTIFIER]: {
            universalIdentifier: EXISTING_ROW_UNIVERSAL_IDENTIFIER,
            fieldMetadataUniversalIdentifier: MARKED_FIELD_UNIVERSAL_IDENTIFIER,
          } as MetadataUniversalFlatEntity<'searchFieldMetadata'>,
        },
        universalIdentifierById: {},
        universalIdentifiersByApplicationId: {},
      },
    },
    context: {
      buildOptions: {
        isSystemBuild: false,
        applicationUniversalIdentifier: APPLICATION_UNIVERSAL_IDENTIFIER,
      },
    },
  } as unknown as BuildSideEffectsArgs<'fieldMetadata'>;
};

describe('FieldAdditionalSearchOnUpdateSideEffectHandlerService', () => {
  const service = new FieldAdditionalSearchOnUpdateSideEffectHandlerService();

  const createdRows = (result: ReturnType<typeof service.buildSideEffects>) =>
    result.status === 'success'
      ? Object.keys(
          result.operations.searchFieldMetadata?.flatEntityToCreate ?? {},
        )
      : [];

  const deletedRows = (result: ReturnType<typeof service.buildSideEffects>) =>
    result.status === 'success'
      ? Object.keys(
          result.operations.searchFieldMetadata?.flatEntityToDelete ?? {},
        )
      : [];

  // There is no pre-update entity on BuildSideEffectsArgs, so the handler reconciles the
  // marker's intent against the rows that already exist rather than diffing before/after.
  it('registers a row when search is turned on for a field that has none', () => {
    const result = service.buildSideEffects(buildArgs({ isRegistered: false }));

    expect(createdRows(result)).toHaveLength(1);
  });

  it('deletes the row when the marker turns search off', () => {
    const result = service.buildSideEffects(
      buildArgs({
        isRegistered: true,
        fieldOverrides: {
          universalSettings: {
            additionalSearch: { ...marker, searchable: false },
          },
          searchFieldMetadataUniversalIdentifiers: [
            EXISTING_ROW_UNIVERSAL_IDENTIFIER,
          ],
        },
      }),
    );

    expect(deletedRows(result)).toEqual([EXISTING_ROW_UNIVERSAL_IDENTIFIER]);
  });

  it('deletes the row when the field is archived', () => {
    const result = service.buildSideEffects(
      buildArgs({
        isRegistered: true,
        fieldOverrides: {
          isActive: false,
          searchFieldMetadataUniversalIdentifiers: [
            EXISTING_ROW_UNIVERSAL_IDENTIFIER,
          ],
        },
      }),
    );

    expect(deletedRows(result)).toEqual([EXISTING_ROW_UNIVERSAL_IDENTIFIER]);
  });

  it('registers the row again when an archived field is restored', () => {
    const result = service.buildSideEffects(
      buildArgs({ isRegistered: false, fieldOverrides: { isActive: true } }),
    );

    expect(createdRows(result)).toHaveLength(1);
  });

  // Reconciling against stored state makes the handler idempotent, which is what lets a
  // retried update settle the same field instead of registering it twice.
  it('does nothing when an enabled field is already registered', () => {
    const result = service.buildSideEffects(buildArgs({ isRegistered: true }));

    expect(result).toEqual({ status: 'noop' });
  });

  it('does nothing when a disabled field was never registered', () => {
    const result = service.buildSideEffects(
      buildArgs({
        isRegistered: false,
        fieldOverrides: {
          universalSettings: {
            additionalSearch: { ...marker, searchable: false },
          },
        },
      }),
    );

    expect(result).toEqual({ status: 'noop' });
  });

  it('does nothing for a field that carries no marker', () => {
    const result = service.buildSideEffects(
      buildArgs({ fieldOverrides: { universalSettings: {} } }),
    );

    expect(result).toEqual({ status: 'noop' });
  });

  // The same product decision as on create: Twenty owns the projectable-type list, so
  // asking for search on a type it cannot project is silence, not an error.
  it('is a no-op rather than a failure for a type search cannot project', () => {
    const result = service.buildSideEffects(
      buildArgs({ fieldOverrides: { type: FieldMetadataType.CURRENCY } }),
    );

    expect(result).toEqual({ status: 'noop' });
  });

  it('fails the operation for a malformed marker', () => {
    const result = service.buildSideEffects(
      buildArgs({
        fieldOverrides: {
          // Deliberately malformed, so by definition it does not satisfy the contract type.
          universalSettings: {
            additionalSearch: { version: 1 },
          } as unknown as MetadataUniversalFlatEntity<'fieldMetadata'>['universalSettings'],
        },
      }),
    );

    expect(result.status).toBe('fail');
  });

  it('fails when the marker target disagrees with the object', () => {
    const result = service.buildSideEffects(
      buildArgs({
        fieldOverrides: {
          universalSettings: {
            additionalSearch: { ...marker, target: 'person' },
          },
        },
      }),
    );

    expect(result.status).toBe('fail');
  });
});
