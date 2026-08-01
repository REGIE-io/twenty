import { FieldMetadataType } from 'twenty-shared/types';

import {
  type FieldTypeAndNameMetadata,
  getTsVectorColumnExpressionFromFields,
} from 'src/engine/workspace-manager/utils/get-ts-vector-column-expression.util';
import { computeSearchVectorAsExpressionFromSearchFieldMetadatas } from 'src/engine/metadata-modules/flat-search-field-metadata/utils/compute-search-vector-as-expression-from-search-field-metadatas.util';

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
  it('indexes select values and labels with SQL-safe literals', () => {
    const result = getTsVectorColumnExpressionFromFields([
      {
        name: 'tier',
        type: FieldMetadataType.SELECT,
        options: [
          {
            id: 'tier-1',
            position: 0,
            value: "owner's",
            label: "Owner's choice",
            color: 'blue',
          },
        ],
      },
    ]);

    expect(result).toContain(`WHEN 'owner''s' THEN 'Owner''s choice'`);
    expect(result).toContain(`WHEN 'owner''s' THEN 'owner''s'`);
    expect(result).not.toContain('"tier"::text');
  });

  it('indexes only the stable value when a select has no options', () => {
    const result = getTsVectorColumnExpressionFromFields([
      { name: 'tier', type: FieldMetadataType.SELECT, options: [] },
    ]);

    expect(result).toContain(
      'COALESCE(public.unaccent_immutable("tier"), \'\')',
    );
    expect(result).not.toContain('CASE "tier"');
  });

  it('indexes multi-select labels in deterministic metadata position order', () => {
    const result = getTsVectorColumnExpressionFromFields([
      {
        name: 'segments',
        type: FieldMetadataType.MULTI_SELECT,
        options: [
          {
            id: 'two',
            position: 2,
            value: 'partner',
            label: 'Partner',
            color: 'blue',
          },
          {
            id: 'one',
            position: 1,
            value: 'enterprise',
            label: 'Enterprise',
            color: 'green',
          },
        ],
      },
    ]);

    expect(result).toContain(
      `CASE WHEN 'enterprise' = ANY("segments") THEN 'enterprise' ELSE '' END`,
    );
    expect(result.indexOf("'enterprise' = ANY")).toBeLessThan(
      result.indexOf("'partner' = ANY"),
    );
    expect(result).not.toContain('array_to_string');
    expect(result).not.toContain('"segments"::text');
  });

  it('uses immutable canonical UTC components for DATE_TIME', () => {
    const result = getTsVectorColumnExpressionFromFields([
      { name: 'occurredAt', type: FieldMetadataType.DATE_TIME },
    ]);

    expect(result).toContain(`timezone('UTC', "occurredAt")`);
    expect(result).toContain("'T'");
    expect(result).toContain("'Z'");
    expect(result).not.toContain('"occurredAt"::text');
  });

  it('does not project arbitrary JSON even if metadata targets it', () => {
    expect(
      computeSearchVectorAsExpressionFromSearchFieldMetadatas([
        {
          name: 'payload',
          type: FieldMetadataType.RAW_JSON,
          position: 0,
          sortKey: 'payload',
        },
      ]),
    ).toBe("to_tsvector('simple', NULL)");
  });

  it('projects currency amount micros as major units without serializing the composite', () => {
    const result = getTsVectorColumnExpressionFromFields([
      { name: 'budget', type: FieldMetadataType.CURRENCY },
    ]);

    expect(result).toContain('"budgetAmountMicros"::numeric / 1000000');
    expect(result).toContain('"budgetCurrencyCode"');
  });

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
