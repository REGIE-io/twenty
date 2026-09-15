import {
  FieldMetadataType,
  type AdditionalSearchMarker,
} from 'twenty-shared/types';

import { type FlatEntityMaps } from 'src/engine/metadata-modules/flat-entity/types/flat-entity-maps.type';
import { getFlatFieldMetadataMock } from 'src/engine/metadata-modules/flat-field-metadata/__mocks__/get-flat-field-metadata.mock';
import { type FlatFieldMetadata } from 'src/engine/metadata-modules/flat-field-metadata/types/flat-field-metadata.type';
import { getFlatObjectMetadataMock } from 'src/engine/metadata-modules/flat-object-metadata/__mocks__/get-flat-object-metadata.mock';
import { type FlatObjectMetadata } from 'src/engine/metadata-modules/flat-object-metadata/types/flat-object-metadata.type';
import { FieldAdditionalSearchOnCreateSideEffectHandlerService } from 'src/engine/metadata-modules/metadata-side-effect/handlers/field-metadata/services/field-additional-search-on-create-side-effect-handler.service';
import { type BuildSideEffectsArgs } from 'src/engine/metadata-modules/metadata-side-effect/interfaces/base-metadata-side-effect-handler.service';
import { SEARCH_VECTOR_FIELD } from 'src/engine/metadata-modules/search-field-metadata/constants/search-vector-field.constants';
import { type MetadataUniversalFlatEntity } from 'src/engine/metadata-modules/flat-entity/types/metadata-universal-flat-entity.type';

// The application universal identifier is used as a v5 namespace by the deterministic
// identifier helpers, so it has to be a real UUID.
const APPLICATION_UNIVERSAL_IDENTIFIER = '11111111-1111-4111-8111-111111111111';
const COMPANY_OBJECT_UNIVERSAL_IDENTIFIER =
  'company-object-universal-identifier';
const SEARCH_VECTOR_UNIVERSAL_IDENTIFIER = 'search-vector-universal-identifier';
const MARKED_FIELD_UNIVERSAL_IDENTIFIER = 'marked-field-universal-identifier';

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
  objectOverrides = {},
  hasSearchVectorField = true,
}: {
  fieldOverrides?: Partial<FlatFieldMetadata>;
  objectOverrides?: Partial<FlatObjectMetadata>;
  hasSearchVectorField?: boolean;
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
    fieldUniversalIdentifiers: hasSearchVectorField
      ? [SEARCH_VECTOR_UNIVERSAL_IDENTIFIER]
      : [],
    ...objectOverrides,
  });

  const flatFieldMetadata = getFlatFieldMetadataMock({
    universalIdentifier: MARKED_FIELD_UNIVERSAL_IDENTIFIER,
    objectMetadataId: 'company-object-id',
    applicationUniversalIdentifier: APPLICATION_UNIVERSAL_IDENTIFIER,
    objectMetadataUniversalIdentifier: COMPANY_OBJECT_UNIVERSAL_IDENTIFIER,
    name: 'searchIntent',
    type: FieldMetadataType.SELECT,
    universalSettings: { additionalSearch: marker },
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
    },
    context: {
      buildOptions: {
        isSystemBuild: false,
        applicationUniversalIdentifier: APPLICATION_UNIVERSAL_IDENTIFIER,
      },
    },
  } as unknown as BuildSideEffectsArgs<'fieldMetadata'>;
};

describe('FieldAdditionalSearchOnCreateSideEffectHandlerService', () => {
  let service: FieldAdditionalSearchOnCreateSideEffectHandlerService;

  beforeEach(() => {
    service = new FieldAdditionalSearchOnCreateSideEffectHandlerService();
  });

  it('does nothing for a field that carries no marker', () => {
    const result = service.buildSideEffects(
      buildArgs({ fieldOverrides: { universalSettings: null } }),
    );

    expect(result).toEqual({ status: 'noop' });
  });

  it('registers exactly one searchFieldMetadata row for a marked active select', () => {
    const result = service.buildSideEffects(buildArgs());

    expect(result.status).toBe('success');

    if (result.status !== 'success') {
      throw new Error('expected a success result');
    }

    const flatEntityToCreate =
      result.operations.searchFieldMetadata?.flatEntityToCreate ?? {};

    expect(Object.keys(flatEntityToCreate)).toHaveLength(1);
    expect(Object.values(flatEntityToCreate)[0]).toMatchObject({
      fieldMetadataUniversalIdentifier: MARKED_FIELD_UNIVERSAL_IDENTIFIER,
      tsVectorFieldMetadataUniversalIdentifier:
        SEARCH_VECTOR_UNIVERSAL_IDENTIFIER,
      objectMetadataUniversalIdentifier: COMPANY_OBJECT_UNIVERSAL_IDENTIFIER,
      position: 0,
    });
  });

  it('registers nothing when the marker turns search off', () => {
    const result = service.buildSideEffects(
      buildArgs({
        fieldOverrides: {
          universalSettings: {
            additionalSearch: { ...marker, searchable: false },
          },
        },
      }),
    );

    expect(result).toEqual({ status: 'noop' });
  });

  it('registers nothing when the field is inactive', () => {
    const result = service.buildSideEffects(
      buildArgs({ fieldOverrides: { isActive: false } }),
    );

    expect(result).toEqual({ status: 'noop' });
  });

  // Twenty owns the list of projectable types; a type it cannot project must not fail
  // field creation, so the owning service can keep sending searchable: true unconditionally.
  it('is a no-op rather than a failure for a type search cannot project', () => {
    const result = service.buildSideEffects(
      buildArgs({ fieldOverrides: { type: FieldMetadataType.NUMBER } }),
    );

    expect(result).toEqual({ status: 'noop' });
  });

  it('fails the operation for a malformed marker', () => {
    const result = service.buildSideEffects(
      buildArgs({
        fieldOverrides: {
          // Deliberately malformed: a marker missing `target` and `searchable`. Typed
          // through `unknown` because the point of the case is input the contract rejects,
          // which by definition does not satisfy the contract's type.
          universalSettings: {
            additionalSearch: { version: 1 },
          } as unknown as MetadataUniversalFlatEntity<'fieldMetadata'>['universalSettings'],
        },
      }),
    );

    expect(result.status).toBe('fail');

    if (result.status !== 'fail') {
      throw new Error('expected a fail result');
    }

    expect(result.metadataName).toBe('fieldMetadata');
    expect(result.type).toBe('create');
    expect(result.errors).toHaveLength(1);
    expect(result.errors[0].message).toContain('target');
  });

  // That service says `account` where Twenty says `company`; a field created against the wrong
  // object must fail loudly rather than be indexed in the wrong place.
  it('fails the operation when the marker target disagrees with the object', () => {
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

    if (result.status !== 'fail') {
      throw new Error('expected a fail result');
    }

    expect(result.errors[0].message).toContain('person');
    expect(result.errors[0].message).toContain('company');
  });

  it('fails the operation when the object has no searchVector field', () => {
    const result = service.buildSideEffects(
      buildArgs({ hasSearchVectorField: false }),
    );

    expect(result.status).toBe('fail');

    if (result.status !== 'fail') {
      throw new Error('expected a fail result');
    }

    expect(result.errors[0].message).toContain('searchVector');
  });
});
