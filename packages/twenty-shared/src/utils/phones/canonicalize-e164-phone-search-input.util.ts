import { parsePhoneNumberWithError } from 'libphonenumber-js';

// Phone-search keys are country calling-code digits followed by national-number
// digits (for example +1 4155550100 becomes 14155550100).
export const canonicalizeE164PhoneSearchInput = (
  phoneNumber: string,
): string | undefined => {
  if (!/^\+[1-9]\d{1,14}$/.test(phoneNumber)) return undefined;

  try {
    const parsed = parsePhoneNumberWithError(phoneNumber);

    if (!parsed.isValid()) return undefined;

    return `${parsed.countryCallingCode}${parsed.nationalNumber}`;
  } catch {
    return undefined;
  }
};
