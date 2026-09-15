export type PhoneSearchCanonicalizationFixture = {
  e164: string;
  canonicalKey: string;
  stored: {
    primaryPhoneCallingCode?: string;
    primaryPhoneNumber?: string;
    additionalPhones?: Array<{ callingCode?: string; number?: string }>;
  };
};

// The request parser consumes e164; SQL only projects the already-structured
// PHONES value. Both must produce this calling-code + national-number key.
export const phoneSearchCanonicalizationFixtures: PhoneSearchCanonicalizationFixture[] =
  [
    {
      e164: '+14155550100',
      canonicalKey: '14155550100',
      stored: {
        primaryPhoneCallingCode: '+1',
        primaryPhoneNumber: '4155550100',
        additionalPhones: [{ callingCode: '+44', number: '2071838750' }],
      },
    },
    {
      e164: '+442071838750',
      canonicalKey: '442071838750',
      stored: {
        primaryPhoneCallingCode: '+44',
        primaryPhoneNumber: '2071838750',
        additionalPhones: [{ callingCode: '+33', number: '145555501' }],
      },
    },
    {
      e164: '+33145555501',
      canonicalKey: '33145555501',
      stored: {
        additionalPhones: [
          { callingCode: '+33', number: '145555501' },
          { callingCode: '+x', number: 'ignored' },
          { callingCode: '+1' },
        ],
      },
    },
  ];

export const malformedPhoneSearchInputs = [
  '4155550100',
  '+1 (415) 555-0100',
  '+1415555010x',
  '+999999999999999',
];
