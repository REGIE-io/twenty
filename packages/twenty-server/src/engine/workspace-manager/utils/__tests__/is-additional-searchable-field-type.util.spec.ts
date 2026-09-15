import { FieldMetadataType } from 'twenty-shared/types';
import { isSearchableFieldType } from 'twenty-shared/utils';

import { isAdditionalSearchableFieldType } from '../is-additional-searchable-field-type.util';

const ADMITTED = [
  FieldMetadataType.TEXT,
  FieldMetadataType.EMAILS,
  FieldMetadataType.PHONES,
  FieldMetadataType.LINKS,
  FieldMetadataType.SELECT,
  FieldMetadataType.MULTI_SELECT,
];

const REFUSED = [
  FieldMetadataType.NUMBER,
  FieldMetadataType.BOOLEAN,
  FieldMetadataType.DATE,
  FieldMetadataType.DATE_TIME,
  FieldMetadataType.CURRENCY,
];

test.each(ADMITTED)('%s is projectable', (type) => {
  expect(isAdditionalSearchableFieldType(type)).toBe(true);
});

test.each(REFUSED)('%s is not projectable', (type) => {
  expect(isAdditionalSearchableFieldType(type)).toBe(false);
});

// The whole point of a separate predicate: stock objects must behave as before.
test('Twenty global predicate is not widened by this change', () => {
  expect(isSearchableFieldType(FieldMetadataType.SELECT)).toBe(false);
  expect(isSearchableFieldType(FieldMetadataType.MULTI_SELECT)).toBe(false);
});
