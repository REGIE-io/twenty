import { computeSearchVectorRebuildTargetUniversalIdentifiers } from 'src/engine/workspace-manager/workspace-migration/utils/compute-search-vector-rebuild-target-universal-identifiers.util';

describe('computeSearchVectorRebuildTargetUniversalIdentifiers', () => {
  it('rebuilds a targeted vector when select or multi-select options change', () => {
    const result = computeSearchVectorRebuildTargetUniversalIdentifiers({
      orchestratorActionsReport: {
        fieldMetadata: {
          create: [],
          delete: [],
          update: [
            {
              universalIdentifier: 'field',
              update: { options: [] },
            },
          ],
        },
        searchFieldMetadata: { create: [], update: [], delete: [] },
        objectMetadata: { create: [] },
      } as any,
      toFlatFieldMetadataMaps: {
        byUniversalIdentifier: {
          field: { searchFieldMetadataUniversalIdentifiers: ['search-field'] },
        },
      } as any,
      toFlatSearchFieldMetadataMaps: {
        byUniversalIdentifier: {
          'search-field': {
            tsVectorFieldMetadataUniversalIdentifier: 'vector',
          },
        },
      } as any,
    });

    expect(result).toEqual(new Set(['vector']));
  });
});
