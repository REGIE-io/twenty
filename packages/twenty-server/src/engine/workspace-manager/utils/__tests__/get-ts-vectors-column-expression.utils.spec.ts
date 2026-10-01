import { FieldMetadataType } from 'twenty-shared/types';

import {
  type FieldTypeAndNameMetadata,
  getLeanTsVectorExpressionFromFields,
  getTsVectorColumnExpressionFromFields,
  SEARCH_VECTOR_TEXT_LIMIT,
} from 'src/engine/workspace-manager/utils/get-ts-vector-column-expression.util';
import { isSafeTsVectorExpression } from 'src/engine/workspace-manager/workspace-migration/utils/remove-sql-injection.util';

const nameTextField = { name: 'name', type: FieldMetadataType.TEXT };
const nameFullNameField = {
  name: 'name',
  type: FieldMetadataType.FULL_NAME,
};
const jobTitleTextField = { name: 'jobTitle', type: FieldMetadataType.TEXT };
const emailsEmailsField = { name: 'emails', type: FieldMetadataType.EMAILS };
const phonesPhonesField = { name: 'phones', type: FieldMetadataType.PHONES };
const linksLinksField = { name: 'domainName', type: FieldMetadataType.LINKS };

describe('getTsVectorColumnExpressionFromFields', () => {
  it('should generate correct expression for simple text field', () => {
    const fields = [nameTextField] as FieldTypeAndNameMetadata[];
    const result = getTsVectorColumnExpressionFromFields(fields);

    expect(result).toContain(
      "to_tsvector('simple', COALESCE(public.unaccent_immutable(\"name\"), ''))",
    );
  });

  it('should handle multiple fields', () => {
    const fields = [
      nameFullNameField,
      jobTitleTextField,
      emailsEmailsField,
    ] as FieldTypeAndNameMetadata[];
    const result = getTsVectorColumnExpressionFromFields(fields);

    expect(result).toContain(
      'COALESCE(public.unaccent_immutable("nameFirstName"), \'\')',
    );
    expect(result).toContain(
      'COALESCE(public.unaccent_immutable("nameLastName"), \'\')',
    );
    expect(result).toContain(
      'COALESCE(public.unaccent_immutable("jobTitle"), \'\')',
    );
    expect(result).toContain(
      'COALESCE(public.unaccent_immutable("emailsPrimaryEmail"), \'\')',
    );
    expect(result).toContain(
      "COALESCE(public.unaccent_immutable(SPLIT_PART(\"emailsPrimaryEmail\", '@', 2)), '')",
    );
  });

  it('should handle text fields', () => {
    const fields = [
      { name: 'body', type: FieldMetadataType.TEXT },
    ] as FieldTypeAndNameMetadata[];
    const result = getTsVectorColumnExpressionFromFields(fields);

    expect(result).toBe(
      "to_tsvector('simple', COALESCE(public.unaccent_immutable(\"body\"), ''))",
    );
  });

  it('should handle rich text v2 fields', () => {
    const fields = [
      { name: 'bodyV2', type: FieldMetadataType.RICH_TEXT },
    ] as FieldTypeAndNameMetadata[];
    const result = getTsVectorColumnExpressionFromFields(fields);

    expect(result).toBe(
      "to_tsvector('simple', COALESCE(public.unaccent_immutable(\"bodyV2Markdown\"), ''))",
    );
  });

  it('should handle phone fields without unaccenting', () => {
    const fields = [phonesPhonesField] as FieldTypeAndNameMetadata[];
    const result = getTsVectorColumnExpressionFromFields(fields);

    expect(result).toContain('COALESCE("phonesPrimaryPhoneNumber", \'\')');
    expect(result).toContain('COALESCE("phonesPrimaryPhoneCallingCode", \'\')');
    expect(result).not.toContain('unaccent_immutable');
  });

  it('should generate international format expressions for phone fields', () => {
    const fields = [phonesPhonesField] as FieldTypeAndNameMetadata[];
    const result = getTsVectorColumnExpressionFromFields(fields);

    expect(result).toContain(
      'COALESCE("phonesPrimaryPhoneCallingCode" || "phonesPrimaryPhoneNumber", \'\')',
    );
    expect(result).toContain(
      "COALESCE(REPLACE(\"phonesPrimaryPhoneCallingCode\", '+', '') || \"phonesPrimaryPhoneNumber\", '')",
    );
  });

  it('should generate trunk prefix format expression for phone fields', () => {
    const fields = [phonesPhonesField] as FieldTypeAndNameMetadata[];
    const result = getTsVectorColumnExpressionFromFields(fields);

    expect(result).toContain(
      "COALESCE('0' || \"phonesPrimaryPhoneNumber\", '')",
    );
  });

  it('should properly index phone subfields including additional phones', () => {
    const fields = [phonesPhonesField] as FieldTypeAndNameMetadata[];
    const result = getTsVectorColumnExpressionFromFields(fields);

    expect(result).toContain('phonesPrimaryPhoneNumber');
    expect(result).toContain('phonesPrimaryPhoneCallingCode');

    expect(result).toContain('phonesAdditionalPhones');
    expect(result).toContain(
      "COALESCE(TRANSLATE(regexp_replace(\"phonesAdditionalPhones\"::text, '\"(number|countryCode|callingCode)\"\\s*:\\s*', '', 'g'), '[]{}\",:',",
    );
  });

  it('should strip additional phone key names before indexing', () => {
    const fields = [phonesPhonesField] as FieldTypeAndNameMetadata[];
    const result = getTsVectorColumnExpressionFromFields(fields);

    expect(result).toContain(
      "regexp_replace(\"phonesAdditionalPhones\"::text, '\"(number|countryCode|callingCode)\"\\s*:\\s*', '', 'g')",
    );
  });

  it('should include additional emails in search expression', () => {
    const fields = [emailsEmailsField] as FieldTypeAndNameMetadata[];
    const result = getTsVectorColumnExpressionFromFields(fields);

    expect(result).toContain('emailsPrimaryEmail');
    expect(result).toContain('emailsAdditionalEmails');
    expect(result).toContain(
      "COALESCE(public.unaccent_immutable(TRANSLATE(\"emailsAdditionalEmails\"::text, '[]\",', '    ')), '')",
    );
    expect(result).toContain(
      "COALESCE(public.unaccent_immutable(TRANSLATE(REPLACE(\"emailsAdditionalEmails\"::text, '@', ' '), '[]\",', '    ')), '')",
    );
  });

  it('should include secondary links in search expression for LINKS type', () => {
    const fields = [linksLinksField] as FieldTypeAndNameMetadata[];
    const result = getTsVectorColumnExpressionFromFields(fields);

    expect(result).toContain('domainNamePrimaryLinkLabel');
    expect(result).toContain('domainNamePrimaryLinkUrl');
    expect(result).toContain('domainNameSecondaryLinks');
    expect(result).toContain(
      "COALESCE(public.unaccent_immutable(TRANSLATE(regexp_replace(\"domainNameSecondaryLinks\"::text, '\"(label|url)\"\\s*:\\s*', '', 'g'), '[]{}\",:',",
    );
  });

  it('should strip secondary link key names before indexing', () => {
    const fields = [linksLinksField] as FieldTypeAndNameMetadata[];
    const result = getTsVectorColumnExpressionFromFields(fields);

    expect(result).toContain(
      "regexp_replace(\"domainNameSecondaryLinks\"::text, '\"(label|url)\"\\s*:\\s*', '', 'g')",
    );
  });

  describe('NULL/empty JSON column handling', () => {
    it('should wrap additionalEmails JSON column with COALESCE for NULL safety', () => {
      const fields = [emailsEmailsField] as FieldTypeAndNameMetadata[];
      const result = getTsVectorColumnExpressionFromFields(fields);

      expect(result).toContain(
        'COALESCE(public.unaccent_immutable(TRANSLATE("emailsAdditionalEmails"::text',
      );
      expect(result).toMatch(
        /COALESCE\(public\.unaccent_immutable\(TRANSLATE\("emailsAdditionalEmails"::text.*\), ''\)/,
      );
    });

    it('should wrap additionalPhones JSON column with COALESCE for NULL safety', () => {
      const fields = [phonesPhonesField] as FieldTypeAndNameMetadata[];
      const result = getTsVectorColumnExpressionFromFields(fields);

      expect(result).toContain(
        'COALESCE(TRANSLATE(regexp_replace("phonesAdditionalPhones"::text',
      );
      expect(result).toMatch(
        /COALESCE\(TRANSLATE\(regexp_replace\("phonesAdditionalPhones"::text.*\), ''\)/,
      );
    });

    it('should wrap secondaryLinks JSON column with COALESCE for NULL safety', () => {
      const fields = [linksLinksField] as FieldTypeAndNameMetadata[];
      const result = getTsVectorColumnExpressionFromFields(fields);

      expect(result).toContain(
        'COALESCE(public.unaccent_immutable(TRANSLATE(regexp_replace("domainNameSecondaryLinks"::text',
      );
      expect(result).toMatch(
        /COALESCE\(public\.unaccent_immutable\(TRANSLATE\(regexp_replace\("domainNameSecondaryLinks"::text.*\), ''\)/,
      );
    });

    it('should use empty string fallback for all JSON array columns', () => {
      const fields = [
        emailsEmailsField,
        phonesPhonesField,
        linksLinksField,
      ] as FieldTypeAndNameMetadata[];
      const result = getTsVectorColumnExpressionFromFields(fields);

      const additionalEmailsCoalesce = result.includes(
        "COALESCE(public.unaccent_immutable(TRANSLATE(\"emailsAdditionalEmails\"::text, '[]\",', '    ')), '')",
      );
      const additionalPhonesCoalesce = result.includes(
        "COALESCE(TRANSLATE(regexp_replace(\"phonesAdditionalPhones\"::text, '\"(number|countryCode|callingCode)\"\\s*:\\s*', '', 'g'), '[]{}\",:',",
      );
      const secondaryLinksCoalesce = result.includes(
        "COALESCE(public.unaccent_immutable(TRANSLATE(regexp_replace(\"domainNameSecondaryLinks\"::text, '\"(label|url)\"\\s*:\\s*', '', 'g'), '[]{}\",:',",
      );

      expect(additionalEmailsCoalesce).toBe(true);
      expect(additionalPhonesCoalesce).toBe(true);
      expect(secondaryLinksCoalesce).toBe(true);
    });
  });
});

describe('getTsVectorColumnExpressionFromFields with additionally searchable dropdown fields', () => {
  const tierSelectField = {
    name: 'acmeTier',
    type: FieldMetadataType.SELECT,
    options: [
      { value: 'GOLD', label: 'Gold', position: 0 },
      { value: 'SILVER', label: 'Silver', position: 1 },
    ],
  } as unknown as FieldTypeAndNameMetadata;

  const segmentsMultiSelectField = {
    name: 'acmeSegments',
    type: FieldMetadataType.MULTI_SELECT,
    options: [
      { value: 'GOLD', label: 'Gold', position: 0 },
      { value: 'SILVER', label: 'Silver', position: 1 },
    ],
  } as unknown as FieldTypeAndNameMetadata;

  it('should index both the stored value and the label of a select', () => {
    const result = getTsVectorColumnExpressionFromFields([tierSelectField]);

    expect(result).toContain("WHEN 'GOLD' THEN 'GOLD'");
    expect(result).toContain("WHEN 'GOLD' THEN 'Gold'");
    expect(result).toContain("WHEN 'SILVER' THEN 'SILVER'");
    expect(result).toContain("WHEN 'SILVER' THEN 'Silver'");
  });

  it('should not cast the raw select column to text', () => {
    const result = getTsVectorColumnExpressionFromFields([tierSelectField]);

    expect(result).not.toContain('"acmeTier"::text');
  });

  it('should escape single quotes in select labels', () => {
    const result = getTsVectorColumnExpressionFromFields([
      {
        name: 'acmeTier',
        type: FieldMetadataType.SELECT,
        options: [{ value: 'OWNER', label: "Owner's choice", position: 0 }],
      },
    ] as unknown as FieldTypeAndNameMetadata[]);

    expect(result).toContain("'Owner''s choice'");
  });

  it('should test membership per option for a multi-select, for value and label', () => {
    const result = getTsVectorColumnExpressionFromFields([
      segmentsMultiSelectField,
    ]);

    expect(result).toContain(
      "CASE WHEN 'GOLD' = ANY(\"acmeSegments\") THEN 'GOLD'",
    );
    expect(result).toContain(
      "CASE WHEN 'GOLD' = ANY(\"acmeSegments\") THEN 'Gold'",
    );
    expect(result).toContain(
      "CASE WHEN 'SILVER' = ANY(\"acmeSegments\") THEN 'SILVER'",
    );
    expect(result).toContain(
      "CASE WHEN 'SILVER' = ANY(\"acmeSegments\") THEN 'Silver'",
    );
  });

  it('should emit select options in metadata position order', () => {
    const result = getTsVectorColumnExpressionFromFields([
      {
        name: 'acmeTier',
        type: FieldMetadataType.SELECT,
        options: [
          { value: 'SILVER', label: 'Silver', position: 1 },
          { value: 'GOLD', label: 'Gold', position: 0 },
        ],
      },
    ] as unknown as FieldTypeAndNameMetadata[]);

    expect(result.indexOf("'GOLD'")).toBeGreaterThan(-1);
    expect(result.indexOf("'GOLD'")).toBeLessThan(result.indexOf("'SILVER'"));
  });

  it('should emit multi-select options in metadata position order', () => {
    const result = getTsVectorColumnExpressionFromFields([
      {
        name: 'acmeSegments',
        type: FieldMetadataType.MULTI_SELECT,
        options: [
          { value: 'SILVER', label: 'Silver', position: 1 },
          { value: 'GOLD', label: 'Gold', position: 0 },
        ],
      },
    ] as unknown as FieldTypeAndNameMetadata[]);

    expect(result.indexOf("'GOLD'")).toBeGreaterThan(-1);
    expect(result.indexOf("'GOLD'")).toBeLessThan(result.indexOf("'SILVER'"));
  });

  it('should contribute an empty projection for a select with no options', () => {
    const result = getTsVectorColumnExpressionFromFields([
      {
        name: 'acmeTier',
        type: FieldMetadataType.SELECT,
        options: [],
      },
    ] as unknown as FieldTypeAndNameMetadata[]);

    expect(result).toBe("to_tsvector('simple', '')");
    expect(isSafeTsVectorExpression(result)).toBe(true);
  });

  it('should contribute an empty projection for a multi-select with undefined options', () => {
    const result = getTsVectorColumnExpressionFromFields([
      {
        name: 'acmeSegments',
        type: FieldMetadataType.MULTI_SELECT,
      },
    ] as unknown as FieldTypeAndNameMetadata[]);

    expect(result).toBe("to_tsvector('simple', '')");
    expect(isSafeTsVectorExpression(result)).toBe(true);
  });

  it('should keep the expression safe when a label contains tsvector-unsafe tokens', () => {
    const result = getTsVectorColumnExpressionFromFields([
      {
        name: 'acmeTier',
        type: FieldMetadataType.SELECT,
        options: [
          { value: 'CHEAP', label: 'Under $10k', position: 0 },
          { value: 'GOLD', label: 'Gold -- premium', position: 1 },
        ],
      },
    ] as unknown as FieldTypeAndNameMetadata[]);

    expect(isSafeTsVectorExpression(result)).toBe(true);
    expect(result).not.toContain('$');
    expect(result).not.toContain('--');
  });

  it('should keep the expression safe when a multi-select label contains tsvector-unsafe tokens', () => {
    const result = getTsVectorColumnExpressionFromFields([
      {
        name: 'acmeSegments',
        type: FieldMetadataType.MULTI_SELECT,
        options: [
          { value: 'CHEAP', label: 'Under $10k', position: 0 },
          { value: 'GOLD', label: 'Gold -- premium', position: 1 },
        ],
      },
    ] as unknown as FieldTypeAndNameMetadata[]);

    expect(isSafeTsVectorExpression(result)).toBe(true);
    expect(result).not.toContain('$');
    expect(result).not.toContain('--');
  });

  it('should keep searchable words intact while sanitising a label', () => {
    const result = getTsVectorColumnExpressionFromFields([
      {
        name: 'acmeTier',
        type: FieldMetadataType.SELECT,
        options: [{ value: 'CHEAP', label: 'Under $10k', position: 0 }],
      },
    ] as unknown as FieldTypeAndNameMetadata[]);

    expect(result).toContain('Under');
    expect(result).toContain('10k');
  });
});

const everyBranchFields: FieldTypeAndNameMetadata[] = [
  { name: 'name', type: FieldMetadataType.FULL_NAME },
  { name: 'emails', type: FieldMetadataType.EMAILS },
  { name: 'phones', type: FieldMetadataType.PHONES },
  { name: 'domainName', type: FieldMetadataType.LINKS },
  { name: 'jobTitle', type: FieldMetadataType.TEXT },
  { name: 'id', type: FieldMetadataType.UUID },
  {
    name: 'aeTier',
    type: FieldMetadataType.SELECT,
    options: [
      { value: 'OPT_1', label: '1', position: 0 },
      { value: 'PARTNER', label: 'Partner', position: 1 },
    ],
  },
  {
    name: 'seniority',
    type: FieldMetadataType.MULTI_SELECT,
    options: [
      { value: 'VP', label: 'VP/SVP', position: 0 },
      { value: 'DIRECTOR', label: 'Director', position: 1 },
    ],
  },
];

const remainingBranchFields: FieldTypeAndNameMetadata[] = [
  { name: 'address', type: FieldMetadataType.ADDRESS },
  { name: 'bodyV2', type: FieldMetadataType.RICH_TEXT },
  { name: 'stage', type: FieldMetadataType.SELECT, options: [] },
  { name: 'tags', type: FieldMetadataType.MULTI_SELECT, options: [] },
];

describe('getTsVectorColumnExpressionFromFields output freeze', () => {
  it('produces exactly the formula stored in prod generated columns', () => {
    expect(getTsVectorColumnExpressionFromFields(everyBranchFields)).toBe(
      "to_tsvector('simple', COALESCE(public.unaccent_immutable(\"nameFirstName\"), '') || ' ' || COALESCE(public.unaccent_immutable(\"nameLastName\"), '') || ' ' || \n      COALESCE(public.unaccent_immutable(\"emailsPrimaryEmail\"), '') || ' ' ||\n      COALESCE(public.unaccent_immutable(SPLIT_PART(\"emailsPrimaryEmail\", '@', 2)), '') || ' ' || COALESCE(public.unaccent_immutable(TRANSLATE(\"emailsAdditionalEmails\"::text, '[]\",', '    ')), '') || ' ' || COALESCE(public.unaccent_immutable(TRANSLATE(REPLACE(\"emailsAdditionalEmails\"::text, '@', ' '), '[]\",', '    ')), '') || ' ' || COALESCE(\"phonesPrimaryPhoneNumber\", '') || ' ' || COALESCE(\"phonesPrimaryPhoneCallingCode\", '') || ' ' || COALESCE(\"phonesPrimaryPhoneCallingCode\" || \"phonesPrimaryPhoneNumber\", '') || ' ' || COALESCE(REPLACE(\"phonesPrimaryPhoneCallingCode\", '+', '') || \"phonesPrimaryPhoneNumber\", '') || ' ' || COALESCE('0' || \"phonesPrimaryPhoneNumber\", '') || ' ' || COALESCE(TRANSLATE(regexp_replace(\"phonesAdditionalPhones\"::text, '\"(number|countryCode|callingCode)\"\\s*:\\s*', '', 'g'), '[]{}\",:', '        '), '') || ' ' || COALESCE(public.unaccent_immutable(\"domainNamePrimaryLinkLabel\"), '') || ' ' || COALESCE(public.unaccent_immutable(\"domainNamePrimaryLinkUrl\"), '') || ' ' || COALESCE(public.unaccent_immutable(TRANSLATE(regexp_replace(\"domainNameSecondaryLinks\"::text, '\"(label|url)\"\\s*:\\s*', '', 'g'), '[]{}\",:', '        ')), '') || ' ' || COALESCE(public.unaccent_immutable(\"jobTitle\"), '') || ' ' || COALESCE(\"id\"::text, '') || ' ' || COALESCE(public.unaccent_immutable(CASE \"aeTier\" WHEN 'OPT_1' THEN 'OPT_1' WHEN 'PARTNER' THEN 'PARTNER' ELSE '' END), '') || ' ' || COALESCE(public.unaccent_immutable(CASE \"aeTier\" WHEN 'OPT_1' THEN '1' WHEN 'PARTNER' THEN 'Partner' ELSE '' END), '') || ' ' || COALESCE(public.unaccent_immutable(CASE WHEN 'VP' = ANY(\"seniority\") THEN 'VP' ELSE '' END || ' ' || CASE WHEN 'DIRECTOR' = ANY(\"seniority\") THEN 'DIRECTOR' ELSE '' END), '') || ' ' || COALESCE(public.unaccent_immutable(CASE WHEN 'VP' = ANY(\"seniority\") THEN 'VP/SVP' ELSE '' END || ' ' || CASE WHEN 'DIRECTOR' = ANY(\"seniority\") THEN 'Director' ELSE '' END), ''))",
    );
  });

  it('produces exactly the formula for address, rich text and option-less dropdowns', () => {
    expect(getTsVectorColumnExpressionFromFields(remainingBranchFields)).toBe(
      "to_tsvector('simple', COALESCE(public.unaccent_immutable(\"addressAddressStreet1\"), '') || ' ' || COALESCE(public.unaccent_immutable(\"addressAddressStreet2\"), '') || ' ' || COALESCE(public.unaccent_immutable(\"addressAddressCity\"), '') || ' ' || COALESCE(public.unaccent_immutable(\"addressAddressPostcode\"), '') || ' ' || COALESCE(public.unaccent_immutable(\"addressAddressState\"), '') || ' ' || COALESCE(public.unaccent_immutable(\"addressAddressCountry\"), '') || ' ' || COALESCE(public.unaccent_immutable(\"bodyV2Markdown\"), '') || ' ' || '' || ' ' || '')",
    );
  });

  it('produces exactly the empty formula', () => {
    expect(getTsVectorColumnExpressionFromFields([])).toBe(
      "to_tsvector('simple', NULL)",
    );
  });
});

describe('getLeanTsVectorExpressionFromFields', () => {
  it('joins every piece once and calls unaccent once', () => {
    const result = getLeanTsVectorExpressionFromFields(
      [
        { name: 'name', type: FieldMetadataType.FULL_NAME },
        { name: 'jobTitle', type: FieldMetadataType.TEXT },
      ],
      { columnReference: 'column' },
    );

    expect(result).toBe(
      `to_tsvector('simple', public.unaccent_immutable(left(concat_ws(' ', concat_ws(' ', COALESCE(("nameFirstName"), ''), COALESCE(("nameLastName"), ''), COALESCE(("jobTitle"), ''))), ${SEARCH_VECTOR_TEXT_LIMIT})))`,
    );
    expect(result.match(/unaccent_immutable/g)).toHaveLength(1);
  });

  it('reads columns from the trigger row when asked to', () => {
    const result = getLeanTsVectorExpressionFromFields(
      [{ name: 'jobTitle', type: FieldMetadataType.TEXT }],
      { columnReference: 'triggerRow' },
    );

    expect(result).toBe(
      `to_tsvector('simple', public.unaccent_immutable(left(concat_ws(' ', concat_ws(' ', COALESCE((NEW."jobTitle"), ''))), ${SEARCH_VECTOR_TEXT_LIMIT})))`,
    );
  });

  it.each([
    [99, 2],
    [100, 3],
    [198, 3],
    [199, 4],
  ])('with %i pieces emits %i concat_ws calls', (fieldCount, expectedCalls) => {
    const fields: FieldTypeAndNameMetadata[] = Array.from(
      { length: fieldCount },
      (_, index) => ({
        name: `field${index}`,
        type: FieldMetadataType.TEXT,
      }),
    );

    const result = getLeanTsVectorExpressionFromFields(fields, {
      columnReference: 'column',
    });

    expect(result.match(/concat_ws\(' ', /g)).toHaveLength(expectedCalls);
  });

  it('throws when the pieces exceed one level of nesting', () => {
    const buildTextFields = (count: number): FieldTypeAndNameMetadata[] =>
      Array.from({ length: count }, (_, index) => ({
        name: `field${index}`,
        type: FieldMetadataType.TEXT,
      }));

    expect(() =>
      getLeanTsVectorExpressionFromFields(buildTextFields(99 * 99), {
        columnReference: 'column',
      }),
    ).not.toThrow();
    expect(() =>
      getLeanTsVectorExpressionFromFields(buildTextFields(99 * 99 + 1), {
        columnReference: 'column',
      }),
    ).toThrow(/Too many searchable columns/);
  });

  it('caps the joined text at 131,072 characters', () => {
    expect(SEARCH_VECTOR_TEXT_LIMIT).toBe(131072);
    expect(
      getLeanTsVectorExpressionFromFields(
        [{ name: 'jobTitle', type: FieldMetadataType.TEXT }],
        { columnReference: 'column' },
      ),
    ).toContain(', 131072)');
  });

  it('returns the empty formula when nothing is searchable', () => {
    expect(
      getLeanTsVectorExpressionFromFields([], { columnReference: 'column' }),
    ).toBe("to_tsvector('simple', NULL)");
  });

  it('stays a safe expression with hostile option labels', () => {
    const result = getLeanTsVectorExpressionFromFields(
      [
        {
          name: 'tier',
          type: FieldMetadataType.SELECT,
          options: [
            { value: 'A', label: "x'; DROP TABLE y; --$$", position: 0 },
          ],
        },
      ],
      { columnReference: 'triggerRow' },
    );

    expect(isSafeTsVectorExpression(result)).toBe(true);
  });

  it('is rejected by the safety check when an option value contains a dollar sign', () => {
    const result = getLeanTsVectorExpressionFromFields(
      [
        {
          name: 'tier',
          type: FieldMetadataType.SELECT,
          options: [{ value: 'A$B', label: 'x', position: 0 }],
        },
      ],
      { columnReference: 'triggerRow' },
    );

    expect(isSafeTsVectorExpression(result)).toBe(false);
  });

  it('emits an empty string piece for a select without options', () => {
    expect(
      getLeanTsVectorExpressionFromFields(
        [{ name: 'tier', type: FieldMetadataType.SELECT, options: [] }],
        { columnReference: 'column' },
      ),
    ).toBe(
      `to_tsvector('simple', public.unaccent_immutable(left(concat_ws(' ', concat_ws(' ', '')), ${SEARCH_VECTOR_TEXT_LIMIT})))`,
    );
  });
});
