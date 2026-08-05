import { FieldMetadataType } from 'twenty-shared/types';

import {
  getTsVectorColumnExpressionFromFields,
  type FieldTypeAndNameMetadata,
} from 'src/engine/workspace-manager/utils/get-ts-vector-column-expression.util';

const REGIE_PROJECTION_FIELDS = [
  { name: 'customText', type: FieldMetadataType.TEXT },
  // External IDs are TEXT fields with the Regie external_id format.
  { name: 'externalId', type: FieldMetadataType.TEXT },
  { name: 'customNumber', type: FieldMetadataType.NUMBER },
  { name: 'customBoolean', type: FieldMetadataType.BOOLEAN },
  { name: 'customDate', type: FieldMetadataType.DATE },
  { name: 'customDateTime', type: FieldMetadataType.DATE_TIME },
  {
    name: 'customSelect',
    type: FieldMetadataType.SELECT,
    options: [
      {
        id: 'select-1',
        position: 0,
        value: "OWNER'S",
        label: "Owner's choice",
        color: 'blue',
      },
    ],
  },
  {
    name: 'customMultiSelect',
    type: FieldMetadataType.MULTI_SELECT,
    options: [
      {
        id: 'multi-2',
        position: 2,
        value: 'PARTNER',
        label: 'Partner',
        color: 'blue',
      },
      {
        id: 'multi-1',
        position: 1,
        value: 'ENTERPRISE',
        label: 'Enterprise',
        color: 'green',
      },
    ],
  },
  { name: 'customCurrency', type: FieldMetadataType.CURRENCY },
  { name: 'customEmails', type: FieldMetadataType.EMAILS },
  { name: 'customPhones', type: FieldMetadataType.PHONES },
  { name: 'customLinks', type: FieldMetadataType.LINKS },
] satisfies FieldTypeAndNameMetadata[];

const COLUMN_DEFINITIONS = `
  "customText" text,
  "externalId" text,
  "customNumber" numeric,
  "customBoolean" boolean,
  "customDate" date,
  "customDateTime" timestamptz,
  "customSelect" text,
  "customMultiSelect" text[],
  "customCurrencyAmountMicros" numeric,
  "customCurrencyCurrencyCode" text,
  "customEmailsPrimaryEmail" text,
  "customEmailsAdditionalEmails" jsonb,
  "customPhonesPrimaryPhoneNumber" text,
  "customPhonesPrimaryPhoneCountryCode" text,
  "customPhonesPrimaryPhoneCallingCode" text,
  "customPhonesAdditionalPhones" jsonb,
  "customLinksPrimaryLinkLabel" text,
  "customLinksPrimaryLinkUrl" text,
  "customLinksSecondaryLinks" jsonb
`;

const TABLE_NAMES = {
  Person: 'regieSearchImmutablePerson',
  Company: 'regieSearchImmutableCompany',
  Task: 'regieSearchImmutableTask',
  CalendarEvent: 'regieSearchImmutableCalendarEvent',
} as const;

const createTableWithExpression = async (
  tableName: string,
  expression: string,
): Promise<void> => {
  await global.testDataSource.query(`DROP TABLE IF EXISTS core."${tableName}"`);
  await global.testDataSource.query(`
    CREATE TABLE core."${tableName}" (
      ${COLUMN_DEFINITIONS},
      "searchVector" tsvector GENERATED ALWAYS AS (${expression}) STORED
    )
  `);
};

describe('Regie custom search generated-column immutability', () => {
  const expression = getTsVectorColumnExpressionFromFields([
    ...REGIE_PROJECTION_FIELDS,
  ]);

  afterAll(async () => {
    await Promise.all(
      Object.values(TABLE_NAMES).map((tableName) =>
        global.testDataSource.query(`DROP TABLE IF EXISTS core."${tableName}"`),
      ),
    );
  });

  it.each(Object.entries(TABLE_NAMES))(
    'accepts every approved projection in a stored generated vector for %s',
    async (_target, tableName) => {
      // PostgreSQL itself is the assertion here: CREATE TABLE rejects any
      // generated expression that calls a non-IMMUTABLE function.
      await expect(
        createTableWithExpression(tableName, expression),
      ).resolves.toBeUndefined();
    },
  );

  it('indexes canonical values, labels, UTC time, composites, nulls, and escaped labels', async () => {
    const tableName = TABLE_NAMES.Person;

    await createTableWithExpression(tableName, expression);
    await global.testDataSource.query(
      `INSERT INTO core."${tableName}" (
        "customText", "externalId", "customNumber", "customBoolean", "customDate", "customDateTime",
        "customSelect", "customMultiSelect", "customCurrencyAmountMicros", "customCurrencyCurrencyCode",
        "customEmailsPrimaryEmail", "customEmailsAdditionalEmails", "customPhonesPrimaryPhoneNumber",
        "customPhonesPrimaryPhoneCountryCode", "customPhonesPrimaryPhoneCallingCode", "customPhonesAdditionalPhones",
        "customLinksPrimaryLinkLabel", "customLinksPrimaryLinkUrl", "customLinksSecondaryLinks"
      ) VALUES (
        'plain text', 'external-42', 12.5, true, DATE '2026-08-03', TIMESTAMPTZ '2026-08-03 04:05:06.123456+02',
        'OWNER''S', ARRAY['PARTNER', 'ENTERPRISE'], 12500000, 'USD',
        'primary@example.com', '["second@example.com"]'::jsonb, '5551234', 'US', '+1',
        '[{"number":"5550000","countryCode":"US","callingCode":"+1"}]'::jsonb,
        'Docs', 'https://example.com', '[{"label":"Support","url":"https://support.example.com"}]'::jsonb
      )`,
    );
    await global.testDataSource.query(
      `INSERT INTO core."${tableName}" DEFAULT VALUES`,
    );

    const rows: { searchVector: string }[] = await global.testDataSource.query(
      `SELECT "searchVector"::text AS "searchVector" FROM core."${tableName}" ORDER BY "customText" NULLS LAST`,
    );

    // PostgreSQL's TS-vector tokenizer splits punctuation-delimited external
    // IDs into searchable lexemes rather than retaining their raw spelling.
    expect(rows[0]?.searchVector).toContain('external');
    expect(rows[0]?.searchVector).toContain('42');
    expect(rows[0]?.searchVector).toContain('owner');
    expect(rows[0]?.searchVector).toContain('choice');
    expect(rows[0]?.searchVector).toContain('enterprise');
    expect(rows[0]?.searchVector).toContain('partner');
    expect(rows[0]?.searchVector).toContain('2026-08-03');
    expect(rows[0]?.searchVector).toContain('02:05:06');
    expect(rows[0]?.searchVector).toContain('12.5');
    expect(rows[0]?.searchVector).toContain('usd');
    expect(rows[0]?.searchVector).toContain('second@example.com');
    expect(rows[1]?.searchVector).toBe('');
  });

  it('accepts label-only Select and Multi-select rebuilds without indexing unmarked fields', async () => {
    const tableName = TABLE_NAMES.Company;
    const rebuiltExpression = getTsVectorColumnExpressionFromFields([
      {
        name: 'customSelect',
        type: FieldMetadataType.SELECT,
        options: [
          {
            id: 'select-1',
            position: 0,
            value: 'OWNER',
            label: 'Renamed owner',
            color: 'blue',
          },
        ],
      },
      {
        name: 'customMultiSelect',
        type: FieldMetadataType.MULTI_SELECT,
        options: [
          {
            id: 'multi-1',
            position: 0,
            value: 'ENTERPRISE',
            label: 'Renamed enterprise',
            color: 'green',
          },
        ],
      },
    ]);

    await createTableWithExpression(tableName, rebuiltExpression);
    await global.testDataSource.query(
      `INSERT INTO core."${tableName}" ("customSelect", "customMultiSelect", "customText")
       VALUES ('OWNER', ARRAY['ENTERPRISE'], 'must not be indexed')`,
    );
    const [row]: { searchVector: string }[] = await global.testDataSource.query(
      `SELECT "searchVector"::text AS "searchVector" FROM core."${tableName}"`,
    );

    expect(row.searchVector).toContain('renamed');
    expect(row.searchVector).toContain('owner');
    expect(row.searchVector).toContain('enterprise');
    expect(row.searchVector).not.toContain('must');
  });
});
