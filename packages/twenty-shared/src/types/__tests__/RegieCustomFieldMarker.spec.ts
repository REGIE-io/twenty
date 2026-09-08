import { parseRegieCustomFieldMarker } from '@/types/RegieCustomFieldMarker';

const valid = { version: 1, target: 'account', searchable: true } as const;

describe('parseRegieCustomFieldMarker', () => {
  it('reports absent when settings carry no marker', () => {
    expect(parseRegieCustomFieldMarker(null).status).toBe('absent');
    expect(parseRegieCustomFieldMarker(undefined).status).toBe('absent');
    expect(parseRegieCustomFieldMarker({}).status).toBe('absent');
    expect(parseRegieCustomFieldMarker({ other: 1 }).status).toBe('absent');
  });

  it('parses a valid marker', () => {
    expect(parseRegieCustomFieldMarker({ regieCustomField: valid })).toEqual({
      status: 'valid',
      marker: valid,
    });
  });

  // Strict on purpose: a key one repository does not understand must fail loudly
  // rather than be silently dropped.
  it('treats an unknown key as invalid rather than ignoring it', () => {
    expect(
      parseRegieCustomFieldMarker({
        regieCustomField: { ...valid, format: 'plain' },
      }).status,
    ).toBe('invalid');
  });

  // This is what forces Twenty to accept a version before Go emits it.
  it('treats an unknown version as invalid', () => {
    expect(
      parseRegieCustomFieldMarker({
        regieCustomField: { ...valid, version: 2 },
      }).status,
    ).toBe('invalid');
  });

  it('names the offending path so the failure is actionable', () => {
    const result = parseRegieCustomFieldMarker({
      regieCustomField: { version: 1, target: 'nope', searchable: true },
    });

    expect(result.status).toBe('invalid');
    expect(result.status === 'invalid' && result.issues.join()).toContain(
      'target',
    );
  });

  it('accepts every target the contract allows', () => {
    for (const target of [
      'person',
      'account',
      'task',
      'calendar_event',
    ] as const) {
      expect(
        parseRegieCustomFieldMarker({
          regieCustomField: { ...valid, target },
        }).status,
      ).toBe('valid');
    }
  });

  it('keeps a disabled marker valid, because the field is still ours', () => {
    const result = parseRegieCustomFieldMarker({
      regieCustomField: { ...valid, searchable: false },
    });

    expect(result).toEqual({
      status: 'valid',
      marker: { ...valid, searchable: false },
    });
  });
});
