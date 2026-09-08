import { FieldMetadataType } from 'twenty-shared/types';

import {
  buildSearchVectorTargetField,
  computeSearchVectorAsExpressionFromSearchFieldMetadatas,
  type SearchVectorTargetField,
} from 'src/engine/metadata-modules/flat-search-field-metadata/utils/compute-search-vector-as-expression-from-search-field-metadatas.util';

describe('computeSearchVectorAsExpressionFromSearchFieldMetadatas', () => {
  it('should keep a Regie select target in the expression', () => {
    const expression = computeSearchVectorAsExpressionFromSearchFieldMetadatas([
      buildSearchVectorTargetField({
        field: {
          name: 'acmeTier',
          type: FieldMetadataType.SELECT,
          options: [{ value: 'GOLD', label: 'Gold', position: 0 }],
        },
        position: 0,
        sortKey: 'search-field-id',
      }),
    ]);

    expect(expression).toContain("'Gold'");
    expect(expression).toContain('"acmeTier"');
  });

  it('should keep a Regie multi-select target in the expression', () => {
    const expression = computeSearchVectorAsExpressionFromSearchFieldMetadatas([
      buildSearchVectorTargetField({
        field: {
          name: 'acmeSegments',
          type: FieldMetadataType.MULTI_SELECT,
          options: [{ value: 'GOLD', label: 'Gold', position: 0 }],
        },
        position: 0,
        sortKey: 'search-field-id',
      }),
    ]);

    expect(expression).toContain('= ANY("acmeSegments")');
    expect(expression).toContain("'Gold'");
  });

  it('should still filter out a type neither predicate admits', () => {
    const expression = computeSearchVectorAsExpressionFromSearchFieldMetadatas([
      {
        name: 'annualRevenue',
        type: FieldMetadataType.CURRENCY,
        position: 0,
        sortKey: 'search-field-id',
      } as SearchVectorTargetField,
    ]);

    expect(expression).toBe("to_tsvector('simple', NULL)");
  });

  it('should keep standard searchable targets in position order', () => {
    const expression = computeSearchVectorAsExpressionFromSearchFieldMetadatas([
      {
        name: 'jobTitle',
        type: FieldMetadataType.TEXT,
        position: 1,
        sortKey: 'b',
      } as SearchVectorTargetField,
      {
        name: 'name',
        type: FieldMetadataType.TEXT,
        position: 0,
        sortKey: 'a',
      } as SearchVectorTargetField,
    ]);

    expect(expression).toBe(
      "to_tsvector('simple', COALESCE(public.unaccent_immutable(\"name\"), '') || ' ' || COALESCE(public.unaccent_immutable(\"jobTitle\"), ''))",
    );
  });
});
