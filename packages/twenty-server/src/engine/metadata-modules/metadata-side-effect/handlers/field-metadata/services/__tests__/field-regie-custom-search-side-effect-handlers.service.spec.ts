import { FieldMetadataType } from 'twenty-shared/types';

import { type BuildSideEffectsArgs } from 'src/engine/metadata-modules/metadata-side-effect/interfaces/base-metadata-side-effect-handler.service';
import { FieldRegieCustomSearchOnCreateSideEffectHandlerService } from 'src/engine/metadata-modules/metadata-side-effect/handlers/field-metadata/services/field-regie-custom-search-on-create-side-effect-handler.service';
import { FieldRegieCustomSearchOnUpdateSideEffectHandlerService } from 'src/engine/metadata-modules/metadata-side-effect/handlers/field-metadata/services/field-regie-custom-search-on-update-side-effect-handler.service';

const FIELD = '10000000-0000-4000-8000-000000000001';
const VECTOR = '10000000-0000-4000-8000-000000000002';
const OBJECT = '10000000-0000-4000-8000-000000000003';
const APPLICATION = '10000000-0000-4000-8000-000000000004';

const field = (overrides: object = {}) => ({
  universalIdentifier: FIELD,
  objectMetadataUniversalIdentifier: OBJECT,
  type: FieldMetadataType.EMAILS,
  isActive: true,
  settings: { regieCustomField: { searchable: true } },
  searchFieldMetadataUniversalIdentifiers: [],
  ...overrides,
});

const args = ({
  incoming = field(),
  existing = incoming,
  rows = {},
}: {
  incoming?: object;
  existing?: object | undefined;
  rows?: object;
} = {}) =>
  ({
    flatEntity: incoming,
    relatedFlatEntityMaps: {
      flatFieldMetadataMaps: {
        byUniversalIdentifier: {
          [FIELD]: existing,
          [VECTOR]: {
            universalIdentifier: VECTOR,
            name: 'searchVector',
            type: FieldMetadataType.TS_VECTOR,
          },
        },
      },
      flatObjectMetadataMaps: {
        byUniversalIdentifier: {
          [OBJECT]: {
            universalIdentifier: OBJECT,
            applicationUniversalIdentifier: APPLICATION,
            fieldUniversalIdentifiers: [VECTOR],
            searchFieldMetadataUniversalIdentifiers: Object.keys(rows),
          },
        },
      },
      flatSearchFieldMetadataMaps: { byUniversalIdentifier: rows },
    },
    allFlatEntityOperationRecordByMetadataName: {},
    context: {},
  }) as unknown as BuildSideEffectsArgs<'fieldMetadata'>;

describe('Regie custom field search side effects', () => {
  const create =
    new (FieldRegieCustomSearchOnCreateSideEffectHandlerService as unknown as new () => FieldRegieCustomSearchOnCreateSideEffectHandlerService)();
  const update =
    new (FieldRegieCustomSearchOnUpdateSideEffectHandlerService as unknown as new () => FieldRegieCustomSearchOnUpdateSideEffectHandlerService)();

  it('registers only an explicitly marked active approved field', () => {
    const result = create.buildSideEffects(args());
    expect(result.status).toBe('success');
    if (result.status !== 'success') throw new Error('expected success');
    expect(
      Object.values(
        result.operations.searchFieldMetadata?.flatEntityToCreate ?? {},
      )[0],
    ).toMatchObject({
      fieldMetadataUniversalIdentifier: FIELD,
      tsVectorFieldMetadataUniversalIdentifier: VECTOR,
      position: 0,
    });
  });

  it('does not register ordinary or unsupported fields', () => {
    expect(
      create.buildSideEffects(args({ incoming: field({ settings: null }) }))
        .status,
    ).toBe('noop');
    expect(
      create.buildSideEffects(
        args({ incoming: field({ type: FieldMetadataType.RAW_JSON }) }),
      ).status,
    ).toBe('noop');
    expect(
      create.buildSideEffects(
        args({ incoming: field({ type: FieldMetadataType.ADDRESS }) }),
      ).status,
    ).toBe('noop');
    expect(
      create.buildSideEffects(
        args({ incoming: field({ type: FieldMetadataType.RICH_TEXT }) }),
      ).status,
    ).toBe('noop');
  });

  it('is idempotent and deletes only its own row', () => {
    const ownRow = {
      universalIdentifier: 'own',
      fieldMetadataUniversalIdentifier: FIELD,
      position: 0,
    };
    const anotherRow = {
      universalIdentifier: 'other',
      fieldMetadataUniversalIdentifier: 'other-field',
      position: 1,
    };
    expect(
      create.buildSideEffects(
        args({ rows: { own: ownRow, other: anotherRow } }),
      ).status,
    ).toBe('noop');

    const result = update.buildSideEffects(
      args({
        incoming: field({ isActive: false }),
        existing: field(),
        rows: { own: ownRow, other: anotherRow },
      }),
    );
    expect(result.status).toBe('success');
    if (result.status !== 'success') throw new Error('expected success');
    expect(
      Object.keys(
        result.operations.searchFieldMetadata?.flatEntityToDelete ?? {},
      ),
    ).toEqual(['own']);
  });

  it('reuses the deterministic identity on restore', () => {
    const original = create.buildSideEffects(args());
    const restored = update.buildSideEffects(
      args({ incoming: field(), existing: field({ isActive: false }) }),
    );
    expect(original.status).toBe('success');
    expect(restored.status).toBe('success');
    if (original.status !== 'success' || restored.status !== 'success')
      throw new Error('expected success');
    expect(
      Object.keys(
        restored.operations.searchFieldMetadata?.flatEntityToCreate ?? {},
      ),
    ).toEqual(
      Object.keys(
        original.operations.searchFieldMetadata?.flatEntityToCreate ?? {},
      ),
    );
  });
});
