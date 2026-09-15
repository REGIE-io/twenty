import {
  FieldMetadataType,
  type AdditionalSearchMarker,
} from 'twenty-shared/types';

import {
  getAdditionalSearchState,
  getAdditionalSearchTargetMismatch,
  isAdditionalSearchEnabled,
  type AdditionalSearchableField,
} from 'src/engine/metadata-modules/metadata-side-effect/handlers/field-metadata/utils/additional-search.util';

const marker: AdditionalSearchMarker = {
  version: 1,
  target: 'account',
  searchable: true,
};

const field = (
  overrides: Partial<AdditionalSearchableField> = {},
): AdditionalSearchableField => ({
  type: FieldMetadataType.SELECT,
  isActive: true,
  universalSettings: { additionalSearch: marker },
  ...overrides,
});

describe('getAdditionalSearchState', () => {
  it('is absent for a field with no marker, since the field is not ours', () => {
    const result = getAdditionalSearchState(field({ universalSettings: {} }));

    expect(result.status).toBe('absent');
  });

  it('is invalid for a malformed marker, and says why', () => {
    const result = getAdditionalSearchState(
      field({ universalSettings: { additionalSearch: { version: 1 } } }),
    );

    expect(result.status).toBe('invalid');
    expect(result).toMatchObject({
      status: 'invalid',
      issues: expect.any(Array),
    });
  });

  it('is disabled, not absent, when searchable is false, because the field is still ours', () => {
    const result = getAdditionalSearchState(
      field({
        universalSettings: {
          additionalSearch: { ...marker, searchable: false },
        },
      }),
    );

    expect(result.status).toBe('disabled');
  });

  it('is unsupported for a type with no projection, which callers treat as a no-op', () => {
    const result = getAdditionalSearchState(
      field({ type: FieldMetadataType.CURRENCY }),
    );

    expect(result.status).toBe('unsupported');
  });

  it('is inactive for an archived field, even with searchable true', () => {
    const result = getAdditionalSearchState(field({ isActive: false }));

    expect(result.status).toBe('inactive');
  });

  it('is enabled for an active, marked, projectable field', () => {
    const result = getAdditionalSearchState(field());

    expect(result.status).toBe('enabled');
  });

  // Precedence is deliberate, not incidental: a field that is both archived and of an
  // unsupported type must resolve to exactly one status. We check disabled, then
  // unsupported, then inactive - a caller that sees `unsupported` learns the more
  // actionable fact (this type can never be searched) than `inactive` (re-activating the
  // field would not be enough on its own).
  it('reports unsupported over inactive when a field is both archived and unsupported', () => {
    const result = getAdditionalSearchState(
      field({ type: FieldMetadataType.CURRENCY, isActive: false }),
    );

    expect(result.status).toBe('unsupported');
  });
});

describe('isAdditionalSearchEnabled', () => {
  it('is true only when getAdditionalSearchState reports enabled', () => {
    expect(isAdditionalSearchEnabled(field())).toBe(true);
    expect(isAdditionalSearchEnabled(field({ isActive: false }))).toBe(false);
    expect(isAdditionalSearchEnabled(field({ universalSettings: {} }))).toBe(
      false,
    );
  });
});

describe('getAdditionalSearchTargetMismatch', () => {
  it('passes for a correct pairing, since account maps to company', () => {
    const result = getAdditionalSearchTargetMismatch({
      marker,
      objectNameSingular: 'company',
    });

    expect(result).toBeUndefined();
  });

  it('reports a person marker on the company object with both names', () => {
    const result = getAdditionalSearchTargetMismatch({
      marker: { ...marker, target: 'person' },
      objectNameSingular: 'company',
    });

    expect(result).toBe('marker target person does not match object company');
  });
});
