import {
  malformedPhoneSearchInputs,
  phoneSearchCanonicalizationFixtures,
} from '@/testing/phone-search-canonicalization.fixtures';
import { canonicalizeE164PhoneSearchInput } from '@/utils/phones/canonicalize-e164-phone-search-input.util';

describe('canonicalizeE164PhoneSearchInput', () => {
  it.each(phoneSearchCanonicalizationFixtures)(
    'canonicalizes $e164 to the phone-search key',
    ({ e164, canonicalKey }) => {
      expect(canonicalizeE164PhoneSearchInput(e164)).toBe(canonicalKey);
    },
  );

  it.each(malformedPhoneSearchInputs)('rejects %s', (input) => {
    expect(canonicalizeE164PhoneSearchInput(input)).toBeUndefined();
  });
});
