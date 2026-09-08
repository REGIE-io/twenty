import {
  FieldMetadataType,
  type RegieCustomFieldMarker,
} from 'twenty-shared/types';

import {
  getRegieSearchState,
  getRegieSearchTargetMismatch,
  isRegieSearchEnabled,
  type RegieSearchableField,
} from 'src/engine/metadata-modules/metadata-side-effect/handlers/field-metadata/utils/regie-custom-search.util';

const marker: RegieCustomFieldMarker = {
  version: 1,
  target: 'account',
  searchable: true,
};

const field = (
  overrides: Partial<RegieSearchableField> = {},
): RegieSearchableField => ({
  type: FieldMetadataType.SELECT,
  isActive: true,
  universalSettings: { regieCustomField: marker },
  ...overrides,
});

describe('getRegieSearchState', () => {
  it('is absent for a field with no marker, since the field is not ours', () => {
    const result = getRegieSearchState(field({ universalSettings: {} }));

    expect(result.status).toBe('absent');
  });

  it('is invalid for a malformed marker, and says why', () => {
    const result = getRegieSearchState(
      field({ universalSettings: { regieCustomField: { version: 1 } } }),
    );

    expect(result.status).toBe('invalid');
    expect(result).toMatchObject({
      status: 'invalid',
      issues: expect.any(Array),
    });
  });

  it('is disabled, not absent, when searchable is false, because the field is still ours', () => {
    const result = getRegieSearchState(
      field({
        universalSettings: {
          regieCustomField: { ...marker, searchable: false },
        },
      }),
    );

    expect(result.status).toBe('disabled');
  });

  it('is unsupported for a type with no projection, which callers treat as a no-op', () => {
    const result = getRegieSearchState(
      field({ type: FieldMetadataType.CURRENCY }),
    );

    expect(result.status).toBe('unsupported');
  });

  it('is inactive for an archived field, even with searchable true', () => {
    const result = getRegieSearchState(field({ isActive: false }));

    expect(result.status).toBe('inactive');
  });

  it('is enabled for an active, marked, projectable field', () => {
    const result = getRegieSearchState(field());

    expect(result.status).toBe('enabled');
  });

  // Precedence is deliberate, not incidental: a field that is both archived and of an
  // unsupported type must resolve to exactly one status. We check disabled, then
  // unsupported, then inactive - a caller that sees `unsupported` learns the more
  // actionable fact (this type can never be searched) than `inactive` (re-activating the
  // field would not be enough on its own).
  it('reports unsupported over inactive when a field is both archived and unsupported', () => {
    const result = getRegieSearchState(
      field({ type: FieldMetadataType.CURRENCY, isActive: false }),
    );

    expect(result.status).toBe('unsupported');
  });
});

describe('isRegieSearchEnabled', () => {
  it('is true only when getRegieSearchState reports enabled', () => {
    expect(isRegieSearchEnabled(field())).toBe(true);
    expect(isRegieSearchEnabled(field({ isActive: false }))).toBe(false);
    expect(isRegieSearchEnabled(field({ universalSettings: {} }))).toBe(false);
  });
});

describe('getRegieSearchTargetMismatch', () => {
  it('passes for a correct pairing, since account maps to company', () => {
    const result = getRegieSearchTargetMismatch({
      marker,
      objectNameSingular: 'company',
    });

    expect(result).toBeUndefined();
  });

  it('reports a person marker on the company object with both names', () => {
    const result = getRegieSearchTargetMismatch({
      marker: { ...marker, target: 'person' },
      objectNameSingular: 'company',
    });

    expect(result).toBe('marker target person does not match object company');
  });
});
