import { isFieldReadable } from '@/utils/permissions/is-field-readable.util';

describe('isFieldReadable', () => {
  it('defaults to allow and only denies an explicit false', () => {
    expect(isFieldReadable(undefined, 'field')).toBe(true);
    expect(isFieldReadable({}, 'field')).toBe(true);
    expect(isFieldReadable({ field: { canRead: null } }, 'field')).toBe(true);
    expect(isFieldReadable({ field: { canRead: false } }, 'field')).toBe(false);
  });
});
