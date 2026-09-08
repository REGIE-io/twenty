import { computeSearchVectorRebuildTargetUniversalIdentifiers } from 'src/engine/workspace-manager/workspace-migration/utils/compute-search-vector-rebuild-target-universal-identifiers.util';

const VECTOR_UNIVERSAL_IDENTIFIER = 'search-vector-universal-identifier';
const SEARCH_ROW_UNIVERSAL_IDENTIFIER = 'search-row-universal-identifier';
const FIELD_UNIVERSAL_IDENTIFIER = 'regie-field-universal-identifier';

const buildArgs = (fieldUpdate: Record<string, unknown>) =>
  ({
    orchestratorActionsReport: {
      fieldMetadata: {
        create: [],
        update: [
          {
            universalIdentifier: FIELD_UNIVERSAL_IDENTIFIER,
            update: fieldUpdate,
          },
        ],
        delete: [],
      },
      objectMetadata: { create: [], update: [], delete: [] },
      searchFieldMetadata: { create: [], update: [], delete: [] },
    },
    toFlatFieldMetadataMaps: {
      byUniversalIdentifier: {
        [FIELD_UNIVERSAL_IDENTIFIER]: {
          universalIdentifier: FIELD_UNIVERSAL_IDENTIFIER,
          searchFieldMetadataUniversalIdentifiers: [
            SEARCH_ROW_UNIVERSAL_IDENTIFIER,
          ],
        },
      },
    },
    toFlatSearchFieldMetadataMaps: {
      byUniversalIdentifier: {
        [SEARCH_ROW_UNIVERSAL_IDENTIFIER]: {
          universalIdentifier: SEARCH_ROW_UNIVERSAL_IDENTIFIER,
          tsVectorFieldMetadataUniversalIdentifier: VECTOR_UNIVERSAL_IDENTIFIER,
        },
      },
    },
  }) as unknown as Parameters<
    typeof computeSearchVectorRebuildTargetUniversalIdentifiers
  >[0];

describe('computeSearchVectorRebuildTargetUniversalIdentifiers', () => {
  // A rename changes the column name the expression reads.
  it('rebuilds the vector when an indexed field is renamed', () => {
    const targets = computeSearchVectorRebuildTargetUniversalIdentifiers(
      buildArgs({ name: 'renamedField' }),
    );

    expect([...targets]).toEqual([VECTOR_UNIVERSAL_IDENTIFIER]);
  });

  // Regie's dropdown projections write option values AND labels into the generated
  // expression, so relabelling "Gold" leaves stale text in the index until it is rebuilt.
  // Standard Twenty fields never put options in the expression, which is why this trigger
  // did not exist before.
  it('rebuilds the vector when an indexed field changes its options', () => {
    const targets = computeSearchVectorRebuildTargetUniversalIdentifiers(
      buildArgs({
        options: [{ value: 'GOLD', label: 'Gold Tier', position: 0 }],
      }),
    );

    expect([...targets]).toEqual([VECTOR_UNIVERSAL_IDENTIFIER]);
  });

  it('does not rebuild for an update that cannot change the expression', () => {
    const targets = computeSearchVectorRebuildTargetUniversalIdentifiers(
      buildArgs({ description: 'a new description' }),
    );

    expect(targets.size).toBe(0);
  });

  it('rebuilds once when a rename and an options change land together', () => {
    const targets = computeSearchVectorRebuildTargetUniversalIdentifiers(
      buildArgs({
        name: 'renamedField',
        options: [{ value: 'GOLD', label: 'Gold Tier', position: 0 }],
      }),
    );

    expect([...targets]).toEqual([VECTOR_UNIVERSAL_IDENTIFIER]);
  });
});
