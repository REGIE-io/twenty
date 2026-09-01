import { FieldMetadataType } from 'twenty-shared/types';

import { computePhoneSearchVectorAsExpressionFromSearchFieldMetadatas } from 'src/engine/metadata-modules/flat-search-field-metadata/utils/compute-phone-search-vector-as-expression-from-search-field-metadatas.util';
import { computeSearchVectorAsExpressionFromSearchFieldMetadatas } from 'src/engine/metadata-modules/flat-search-field-metadata/utils/compute-search-vector-as-expression-from-search-field-metadatas.util';
import { getTsVectorColumnExpressionFromFields } from 'src/engine/workspace-manager/utils/get-ts-vector-column-expression.util';

describe('computePhoneSearchVectorAsExpressionFromSearchFieldMetadatas', () => {
  it('uses immutable null-safe concatenation so sparse phone fields cannot null the generated vector', () => {
    const expression =
      computePhoneSearchVectorAsExpressionFromSearchFieldMetadatas([
        {
          name: 'phones',
          type: FieldMetadataType.PHONES,
          universalIdentifier: 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa',
          position: 0,
          sortKey: 'a',
        },
        {
          name: 'alternatePhones',
          type: FieldMetadataType.PHONES,
          universalIdentifier: 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb',
          position: 1,
          sortKey: 'b',
        },
      ]);

    expect(expression).toContain('COALESCE(public.phone_search_tokens(');
    expect(expression).toContain(
      "public.phone_search_tokens('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa'",
    );
    expect(expression).toContain(
      "public.phone_search_tokens('bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb'",
    );
    expect(expression).toContain(" || ' ' || ");
  });

  it('does not include non-phone sources', () => {
    expect(
      computePhoneSearchVectorAsExpressionFromSearchFieldMetadatas([
        {
          name: 'title',
          type: FieldMetadataType.TEXT,
          universalIdentifier: 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa',
          position: 0,
          sortKey: 'a',
        },
      ]),
    ).toBe("to_tsvector('simple', NULL)");
  });

  it('leaves the generic vector expression byte-for-byte equal to the legacy generator', () => {
    const fields = [
      {
        name: 'name',
        type: FieldMetadataType.FULL_NAME,
        universalIdentifier: 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa',
        position: 0,
        sortKey: 'a',
      },
      {
        name: 'phones',
        type: FieldMetadataType.PHONES,
        universalIdentifier: 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb',
        position: 1,
        sortKey: 'b',
      },
    ];

    expect(
      computeSearchVectorAsExpressionFromSearchFieldMetadatas(fields),
    ).toBe(
      getTsVectorColumnExpressionFromFields(
        fields.map(({ name, type }) => ({ name, type })) as Parameters<
          typeof getTsVectorColumnExpressionFromFields
        >[0],
      ),
    );
  });
});
