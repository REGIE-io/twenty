import { FieldMetadataType } from 'twenty-shared/types';

import { computeWhereConditionParts } from 'src/engine/api/graphql/graphql-query-runner/utils/compute-where-condition-parts';

describe('computeWhereConditionParts match operator', () => {
  const buildPartsFor = (operator: string) =>
    computeWhereConditionParts({
      operator,
      objectNameSingular: 'company',
      key: 'searchVector',
      value: 'acme gold',
      fieldMetadataType: FieldMetadataType.TS_VECTOR,
    });

  it('matches the search vector without an ILIKE fallback, so a GIN index stays usable', () => {
    const { sql, params } = buildPartsFor('match');

    expect(sql).toContain('"company"."searchVector" @@ to_tsquery');
    expect(sql).not.toContain('ILIKE');
    expect(Object.values(params)).toEqual(['acme:* & gold:*']);
  });

  it('leaves the existing search operator alone', () => {
    const { sql } = buildPartsFor('search');

    expect(sql).toContain('@@ to_tsquery');
    expect(sql).toContain('ILIKE');
  });
});
