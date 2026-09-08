import { FieldMetadataType } from 'twenty-shared/types';

import { deriveSearchVectorAsExpressionForTsVectorField } from 'src/engine/metadata-modules/flat-search-field-metadata/utils/derive-search-vector-as-expression-for-ts-vector-field.util';
import { computeSearchVectorAsExpressionFromSearchFieldMetadatas } from 'src/engine/metadata-modules/flat-search-field-metadata/utils/compute-search-vector-as-expression-from-search-field-metadatas.util';

jest.mock(
  'src/engine/metadata-modules/flat-search-field-metadata/utils/compute-search-vector-as-expression-from-search-field-metadatas.util',
  () => ({
    ...jest.requireActual(
      'src/engine/metadata-modules/flat-search-field-metadata/utils/compute-search-vector-as-expression-from-search-field-metadatas.util',
    ),
    computeSearchVectorAsExpressionFromSearchFieldMetadatas: jest.fn(),
  }),
);

const mockedSearchVectorExpression = jest.mocked(
  computeSearchVectorAsExpressionFromSearchFieldMetadatas,
);

// Used to un-mock computeSearchVectorAsExpressionFromSearchFieldMetadatas for the two
// tests below, which exercise the real runtime path end to end (buildSearchVectorTargetField
// through to the SQL expression) rather than a stubbed return value.
const {
  computeSearchVectorAsExpressionFromSearchFieldMetadatas:
    actualComputeSearchVectorAsExpressionFromSearchFieldMetadatas,
} = jest.requireActual(
  'src/engine/metadata-modules/flat-search-field-metadata/utils/compute-search-vector-as-expression-from-search-field-metadatas.util',
);

describe('deriveSearchVectorAsExpressionForTsVectorField', () => {
  const args = {
    targetSearchFieldMetadatas: [
      {
        fieldMetadataId: 'phone-field-id',
        position: 0,
        universalIdentifier: 'search-field-id',
      },
    ],
    indexedFieldById: new Map([
      [
        'phone-field-id',
        {
          name: 'phones',
          type: FieldMetadataType.PHONES,
        },
      ],
    ]),
  } as unknown as Parameters<
    typeof deriveSearchVectorAsExpressionForTsVectorField
  >[0];

  afterEach(() => jest.resetAllMocks());

  it('accepts a valid derived expression before it reaches DDL', () => {
    mockedSearchVectorExpression.mockReturnValue(
      "to_tsvector('simple', COALESCE(\"name\", ''))",
    );

    expect(() =>
      deriveSearchVectorAsExpressionForTsVectorField(args),
    ).not.toThrow();
  });

  it('rejects an unsafe derived expression before it reaches DDL', () => {
    mockedSearchVectorExpression.mockReturnValue(
      "to_tsvector('simple', '') ; DROP TABLE person",
    );

    expect(() => deriveSearchVectorAsExpressionForTsVectorField(args)).toThrow(
      'Unsafe tsvector expression detected',
    );
  });

  it('a select field indexes its option labels through the runtime path', () => {
    mockedSearchVectorExpression.mockImplementation(
      actualComputeSearchVectorAsExpressionFromSearchFieldMetadatas,
    );

    const expression = deriveSearchVectorAsExpressionForTsVectorField({
      targetSearchFieldMetadatas: [
        { fieldMetadataId: 'f-1', position: 0, universalIdentifier: 'u-1' },
      ],
      indexedFieldById: new Map([
        [
          'f-1',
          {
            name: 'acmeTier',
            type: FieldMetadataType.SELECT,
            options: [{ value: 'GOLD', label: 'Gold', position: 0 }],
          },
        ],
      ]),
    } as unknown as Parameters<
      typeof deriveSearchVectorAsExpressionForTsVectorField
    >[0]);

    expect(expression).toContain("'Gold'");
  });

  // The regression this task exists to prevent: indexedFieldById's value type had no
  // `options`, so a registered SELECT field silently indexed nothing in production while
  // every unit test passed, because tests always constructed options-bearing fixtures.
  it('a select field whose options are dropped indexes nothing', () => {
    mockedSearchVectorExpression.mockImplementation(
      actualComputeSearchVectorAsExpressionFromSearchFieldMetadatas,
    );

    const expression = deriveSearchVectorAsExpressionForTsVectorField({
      targetSearchFieldMetadatas: [
        { fieldMetadataId: 'f-1', position: 0, universalIdentifier: 'u-1' },
      ],
      indexedFieldById: new Map([
        ['f-1', { name: 'acmeTier', type: FieldMetadataType.SELECT }],
      ]),
    } as unknown as Parameters<
      typeof deriveSearchVectorAsExpressionForTsVectorField
    >[0]);

    expect(expression).not.toContain('CASE');
  });
});
