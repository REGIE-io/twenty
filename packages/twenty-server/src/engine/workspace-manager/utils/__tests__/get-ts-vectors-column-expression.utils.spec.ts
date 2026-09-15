import { FieldMetadataType } from 'twenty-shared/types';

import {
  type FieldTypeAndNameMetadata,
  getTsVectorColumnExpressionFromFields,
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
