import { parseRegieCustomFieldMarker } from '../FieldMetadataSettings';

const validMarker = {
  version: 1,
  target: 'person',
  format: 'plain',
  searchable: true,
};

describe('parseRegieCustomFieldMarker', () => {
  // This is the cross-repository v1 fixture table. Go mirrors these exact
  // cases so neither side silently accepts a marker the other rejects.
  it.each([
    ['absent settings', null, 'absent'],
    ['unrelated outer sibling only', { displayedMaxRows: 4 }, 'absent'],
    ['valid searchable marker', { regieCustomField: validMarker }, 'valid'],
    [
      'valid disabled marker with outer sibling',
      {
        displayedMaxRows: 4,
        regieCustomField: { ...validMarker, searchable: false },
      },
      'valid',
    ],
    ['null marker', { regieCustomField: null }, 'invalid'],
    [
      'missing version',
      { regieCustomField: { ...validMarker, version: undefined } },
      'invalid',
    ],
    [
      'unsupported version',
      { regieCustomField: { ...validMarker, version: 2 } },
      'invalid',
    ],
    [
      'bad target',
      { regieCustomField: { ...validMarker, target: 'lead' } },
      'invalid',
    ],
    [
      'bad format',
      { regieCustomField: { ...validMarker, format: 'currency' } },
      'invalid',
    ],
    [
      'string searchable',
      { regieCustomField: { ...validMarker, searchable: 'true' } },
      'invalid',
    ],
    [
      'unknown marker key',
      { regieCustomField: { ...validMarker, unexpected: true } },
      'invalid',
    ],
  ])('%s is %s', (_name, settings, status) => {
    const result = parseRegieCustomFieldMarker(settings);

    expect(result.status).toBe(status);
  });

  it('returns the exact marker while ignoring unrelated outer siblings', () => {
    expect(
      parseRegieCustomFieldMarker({
        displayedMaxRows: 4,
        regieCustomField: validMarker,
      }),
    ).toEqual({ status: 'valid', marker: validMarker });
  });
});
