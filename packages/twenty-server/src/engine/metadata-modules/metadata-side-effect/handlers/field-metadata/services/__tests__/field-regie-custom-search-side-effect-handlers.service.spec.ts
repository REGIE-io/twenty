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
  universalSettings: {
    regieCustomField: {
      version: 1,
      target: 'person',
      format: 'plain',
      searchable: true,
    },
  },
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
            nameSingular: 'person',
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

  it.each([FieldMetadataType.SELECT, FieldMetadataType.MULTI_SELECT])(
    'keeps the strict marker searchable for %s fields',
    (type) => {
      const result = create.buildSideEffects(
        args({ incoming: field({ type }) }),
      );
      expect(result.status).toBe('success');
    },
  );

  it('does not register ordinary fields, but fails closed for malformed markers', () => {
    expect(
      create.buildSideEffects(
        args({ incoming: field({ universalSettings: null }) }),
      )
        .status,
    ).toBe('noop');
    expect(
      create.buildSideEffects(
        args({
          incoming: field({
            universalSettings: { regieCustomField: { searchable: true } },
          }),
        }),
      ).status,
    ).toBe('fail');
    expect(
      create.buildSideEffects(
        args({
          incoming: field({
            universalSettings: {
              regieCustomField: {
                version: 2,
                target: 'person',
                format: 'plain',
                searchable: true,
              },
            },
          }),
        }),
      ).status,
    ).toBe('fail');
    expect(
      create.buildSideEffects(
        args({
          incoming: field({
            universalSettings: {
              regieCustomField: {
                version: 1,
                target: 'person',
                format: 'plain',
                searchable: true,
                extra: true,
              },
            },
          }),
        }),
      ).status,
    ).toBe('fail');
    expect(
      create.buildSideEffects(
        args({
          incoming: field({
            universalSettings: {
              regieCustomField: {
                version: 1,
                target: 'lead',
                format: 'not-a-format',
                searchable: 'yes',
              },
            },
          }),
        }),
      ).status,
    ).toBe('fail');
    expect(
      create.buildSideEffects(
        args({ incoming: field({ type: FieldMetadataType.RAW_JSON }) }),
      ).status,
    ).toBe('fail');
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

  it('fails closed when the marker targets a different object or searchVector is missing', () => {
    expect(
      create.buildSideEffects(
        args({
          incoming: field({
            universalSettings: {
              regieCustomField: {
                version: 1,
                target: 'account',
                format: 'plain',
                searchable: true,
              },
            },
          }),
        }),
      ).status,
    ).toBe('fail');

    const noVectorArgs = args();
    delete noVectorArgs.relatedFlatEntityMaps.flatFieldMetadataMaps
      .byUniversalIdentifier[VECTOR];
    expect(create.buildSideEffects(noVectorArgs).status).toBe('fail');

    const noObjectArgs = args();
    delete noObjectArgs.relatedFlatEntityMaps.flatObjectMetadataMaps
      .byUniversalIdentifier[OBJECT];
    expect(create.buildSideEffects(noObjectArgs).status).toBe('fail');

    expect(
      update.buildSideEffects(
        args({
          incoming: field({
            isActive: false,
            universalSettings: {
              regieCustomField: {
                version: 1,
                target: 'account',
                format: 'plain',
                searchable: false,
              },
            },
          }),
          existing: field(),
        }),
      ).status,
    ).toBe('fail');
  });

  it('removes a disabled marker and repairs a previously invalid marker on update', () => {
    const ownRow = {
      universalIdentifier: 'own',
      fieldMetadataUniversalIdentifier: FIELD,
      position: 0,
    };
    expect(
      update.buildSideEffects(
        args({
          incoming: field({
            universalSettings: {
              regieCustomField: {
                version: 1,
                target: 'person',
                format: 'plain',
                searchable: false,
              },
            },
          }),
          existing: field(),
          rows: { own: ownRow },
        }),
      ).status,
    ).toBe('success');

    const repaired = update.buildSideEffects(
      args({
        incoming: field(),
        existing: field({
          universalSettings: { regieCustomField: { searchable: true } },
        }),
      }),
    );
    expect(repaired.status).toBe('success');

    const retry = update.buildSideEffects(
      args({ incoming: field(), existing: field() }),
    );
    expect(retry.status).toBe('success');
  });
});
