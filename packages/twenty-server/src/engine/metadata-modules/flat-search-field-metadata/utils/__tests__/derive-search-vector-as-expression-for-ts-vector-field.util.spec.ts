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
});
