import {
  parseRegieSource,
  REGIE_SOURCES,
  type RegieSource,
} from '../RegieSource';

describe('parseRegieSource', () => {
  it('accepts every declared source', () => {
    for (const source of REGIE_SOURCES) {
      expect(parseRegieSource(source)).toBe(source);
    }
  });

  it('rejects an unrecognised value', () => {
    expect(parseRegieSource('marketing')).toBeUndefined();
    expect(parseRegieSource('TYPED_BY_HAND')).toBeUndefined();
    expect(parseRegieSource('')).toBeUndefined();
  });

  it('rejects absent or non-string input', () => {
    expect(parseRegieSource(undefined)).toBeUndefined();
    expect(parseRegieSource(null)).toBeUndefined();
    // A repeated header arrives as an array; it is ambiguous, so it is not a source.
    expect(parseRegieSource(['csv', 'api'])).toBeUndefined();
  });

  it('has no duplicate entries', () => {
    expect(new Set(REGIE_SOURCES).size).toBe(REGIE_SOURCES.length);
  });

  it('exposes exactly the eight product sources', () => {
    const expected: RegieSource[] = [
      'typed_by_hand',
      'csv',
      'enrichment',
      'research',
      'hubspot',
      'salesforce',
      'api',
      'automation',
    ];
    expect([...REGIE_SOURCES].sort()).toEqual([...expected].sort());
  });
});
