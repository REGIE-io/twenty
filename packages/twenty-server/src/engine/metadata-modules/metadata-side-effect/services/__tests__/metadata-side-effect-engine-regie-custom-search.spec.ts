import { FieldMetadataType } from 'twenty-shared/types';

import { FieldRegieCustomSearchOnCreateSideEffectHandlerService } from 'src/engine/metadata-modules/metadata-side-effect/handlers/field-metadata/services/field-regie-custom-search-on-create-side-effect-handler.service';
import { FieldRegieCustomSearchOnUpdateSideEffectHandlerService } from 'src/engine/metadata-modules/metadata-side-effect/handlers/field-metadata/services/field-regie-custom-search-on-update-side-effect-handler.service';
import { MetadataSideEffectEngineService } from 'src/engine/metadata-modules/metadata-side-effect/services/metadata-side-effect-engine.service';

const FIELD = '10000000-0000-4000-8000-000000000001';
const VECTOR = '10000000-0000-4000-8000-000000000002';
const OBJECT = '10000000-0000-4000-8000-000000000003';
const APPLICATION = '10000000-0000-4000-8000-000000000004';

const field = (overrides: object = {}) => ({
  universalIdentifier: FIELD,
  objectMetadataUniversalIdentifier: OBJECT,
  type: FieldMetadataType.EMAILS,
  isActive: true,
  name: 'regieEmail',
  universalSettings: {
    regieCustomField: {
      version: 1,
      target: 'person',
      format: 'plain',
      searchable: true,
    },
  },
  ...overrides,
});

const operationRecord = (operation: 'create' | 'update', entity: object) =>
  ({
    fieldMetadata: {
      flatEntityToCreate: operation === 'create' ? { [FIELD]: entity } : {},
      flatEntityToUpdate: operation === 'update' ? { [FIELD]: entity } : {},
      flatEntityToDelete: {},
    },
  }) as never;

const relatedMaps = (rows: object = {}) =>
  ({
    flatFieldMetadataMaps: {
      byUniversalIdentifier: {
        [FIELD]: field(),
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
  }) as never;

const engineFor = (
  operation: 'create' | 'update',
  handler:
    | FieldRegieCustomSearchOnCreateSideEffectHandlerService
    | FieldRegieCustomSearchOnUpdateSideEffectHandlerService,
) =>
  new MetadataSideEffectEngineService({
    getRegisteredHandlerKeys: () => [
      { operation, metadataName: 'fieldMetadata' },
    ],
    getHandlers: () => [handler],
  } as never);

describe('Regie marker failures through the metadata side-effect engine', () => {
  it('returns a build failure without producing a search mutation', () => {
    const handler =
      new (FieldRegieCustomSearchOnCreateSideEffectHandlerService as unknown as new () => FieldRegieCustomSearchOnCreateSideEffectHandlerService)();
    const input = operationRecord(
      'create',
      field({ universalSettings: { regieCustomField: { searchable: true } } }),
    );

    const result = engineFor('create', handler).expandWithSideEffects({
      allFlatEntityOperationRecordByMetadataName: input,
      sideEffectRelatedFlatEntityMaps: relatedMaps(),
      context: { buildOptions: { isSystemBuild: false } },
    });

    expect(result.status).toBe('fail');
    if (result.status !== 'fail') throw new Error('expected build failure');
    expect(result.report.fieldMetadata).toHaveLength(1);
    // The engine deliberately does not return an expanded mutation matrix on
    // failure, so the caller cannot run the triggering field mutation or a
    // partial search-field mutation.
    expect('allFlatEntityOperationRecordByMetadataName' in result).toBe(false);
    expect(input).toEqual(
      operationRecord(
        'create',
        field({ universalSettings: { regieCustomField: { searchable: true } } }),
      ),
    );
  });

  it('adds a missing row on update and is an idempotent noop once repaired', () => {
    const handler =
      new (FieldRegieCustomSearchOnUpdateSideEffectHandlerService as unknown as new () => FieldRegieCustomSearchOnUpdateSideEffectHandlerService)();
    const engine = engineFor('update', handler);

    const repaired = engine.expandWithSideEffects({
      allFlatEntityOperationRecordByMetadataName: operationRecord(
        'update',
        field(),
      ),
      sideEffectRelatedFlatEntityMaps: relatedMaps(),
      context: { buildOptions: { isSystemBuild: false } },
    });
    expect(repaired.status).toBe('success');
    if (repaired.status !== 'success') throw new Error('expected success');
    const createdRows =
      repaired.allFlatEntityOperationRecordByMetadataName.searchFieldMetadata
        ?.flatEntityToCreate ?? {};
    expect(Object.keys(createdRows)).toHaveLength(1);

    const [rowId, row] = Object.entries(createdRows)[0];
    const retry = engine.expandWithSideEffects({
      allFlatEntityOperationRecordByMetadataName: operationRecord(
        'update',
        field(),
      ),
      sideEffectRelatedFlatEntityMaps: relatedMaps({ [rowId]: row }),
      context: { buildOptions: { isSystemBuild: false } },
    });
    expect(retry.status).toBe('success');
    if (retry.status !== 'success') throw new Error('expected success');
    expect(
      retry.allFlatEntityOperationRecordByMetadataName.searchFieldMetadata,
    ).toBeUndefined();
  });
});
