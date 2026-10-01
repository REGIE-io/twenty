import { FieldMetadataType } from 'twenty-shared/types';
import { DataSource } from 'typeorm';

import { SearchVectorTriggerConversionService } from 'src/engine/core-modules/search-vector-trigger/services/search-vector-trigger-conversion.service';
import {
  type FieldTypeAndNameMetadata,
  getLeanTsVectorExpressionFromFields,
  getTsVectorColumnExpressionFromFields,
} from 'src/engine/workspace-manager/utils/get-ts-vector-column-expression.util';

const SCHEMA = 'search_vector_conversion_test';
const fields: FieldTypeAndNameMetadata[] = [
  { name: 'name', type: FieldMetadataType.FULL_NAME },
  { name: 'jobTitle', type: FieldMetadataType.TEXT },
];

describe('SearchVectorTriggerConversionService.convertTable', () => {
  let dataSource: DataSource;
  let service: SearchVectorTriggerConversionService;

  const leanColumnExpression = getLeanTsVectorExpressionFromFields(fields, {
    columnReference: 'column',
  });
  const triggerRowExpression = getLeanTsVectorExpressionFromFields(fields, {
    columnReference: 'triggerRow',
  });

  const readGenerated = async (): Promise<string> => {
    const [{ attgenerated }] = await dataSource.query(
      `SELECT attgenerated FROM pg_attribute WHERE attrelid = '"${SCHEMA}"."person"'::regclass AND attname = 'searchVector'`,
    );

    return attgenerated;
  };

  beforeAll(async () => {
    dataSource = new DataSource({
      type: 'postgres',
      url: process.env.PG_DATABASE_URL,
      synchronize: false,
    });
    await dataSource.initialize();
    service = new SearchVectorTriggerConversionService(dataSource, {
      getOrRecompute: jest.fn(),
    } as never);
  });

  beforeEach(async () => {
    await dataSource.query(`DROP SCHEMA IF EXISTS "${SCHEMA}" CASCADE`);
    await dataSource.query(`CREATE SCHEMA "${SCHEMA}"`);
    await dataSource.query(`CREATE TABLE "${SCHEMA}"."person" (
      "id" serial PRIMARY KEY, "nameFirstName" text, "nameLastName" text, "jobTitle" text,
      "searchVector" tsvector GENERATED ALWAYS AS (${getTsVectorColumnExpressionFromFields(fields)}) STORED
    )`);
    await dataSource.query(`INSERT INTO "${SCHEMA}"."person" ("nameFirstName","nameLastName","jobTitle")
      VALUES ('Samuel','Sunderaraj','VP Sales'), ('José','Müller',NULL)`);
  });

  afterAll(async () => {
    if (dataSource?.isInitialized) {
      try {
        await dataSource.query(`DROP SCHEMA IF EXISTS "${SCHEMA}" CASCADE`);
      } finally {
        await dataSource.destroy();
      }
    }
  });

  const convert = (dryRun: boolean) =>
    service.convertTable({
      schemaName: SCHEMA,
      tableName: 'person',
      leanColumnExpression,
      triggerRowExpression,
      dryRun,
    });

  it('dry run checks and changes nothing', async () => {
    await expect(convert(true)).resolves.toEqual({
      status: 'dryRun',
      mismatchCount: 0,
    });
    expect(await readGenerated()).toBe('s');
  });

  it('converts without changing any stored vector, then keeps vectors current', async () => {
    const before = await dataSource.query(
      `SELECT id, "searchVector"::text AS v FROM "${SCHEMA}"."person" ORDER BY id`,
    );

    await expect(convert(false)).resolves.toEqual({
      status: 'converted',
      mismatchCount: 0,
    });

    const after = await dataSource.query(
      `SELECT id, "searchVector"::text AS v FROM "${SCHEMA}"."person" ORDER BY id`,
    );
    expect(after).toEqual(before);
    expect(await readGenerated()).toBe('');

    await dataSource.query(
      `UPDATE "${SCHEMA}"."person" SET "jobTitle" = 'Chief Hacker' WHERE "nameFirstName" = 'Samuel'`,
    );
    await dataSource.query(
      `INSERT INTO "${SCHEMA}"."person" ("nameFirstName") VALUES ('Zoë')`,
    );
    const [{ hackers, zoes }] = await dataSource.query(
      `SELECT count(*) FILTER (WHERE "searchVector" @@ to_tsquery('simple', 'hacker'))::int AS hackers,
              count(*) FILTER (WHERE "searchVector" @@ to_tsquery('simple', 'zoe'))::int AS zoes
         FROM "${SCHEMA}"."person"`,
    );
    expect(hackers).toBe(1);
    expect(zoes).toBe(1);
  });

  it('is idempotent', async () => {
    await convert(false);
    await expect(convert(false)).resolves.toEqual({
      status: 'alreadyConverted',
      mismatchCount: 0,
    });
  });

  it('refuses when a stored vector differs from the lean formula', async () => {
    const otherFields: FieldTypeAndNameMetadata[] = [
      { name: 'jobTitle', type: FieldMetadataType.TEXT },
    ];

    await expect(
      service.convertTable({
        schemaName: SCHEMA,
        tableName: 'person',
        leanColumnExpression: getLeanTsVectorExpressionFromFields(otherFields, {
          columnReference: 'column',
        }),
        triggerRowExpression,
        dryRun: false,
      }),
    ).resolves.toEqual({ status: 'mismatch', mismatchCount: 2 });
    expect(await readGenerated()).toBe('s');
  });

  it('rolls back and stays generated when the trigger expression is broken', async () => {
    const brokenTriggerExpression = `to_tsvector('simple', COALESCE((NEW."doesNotExist"), ''))`;

    await expect(
      service.convertTable({
        schemaName: SCHEMA,
        tableName: 'person',
        leanColumnExpression,
        triggerRowExpression: brokenTriggerExpression,
        dryRun: false,
      }),
    ).rejects.toThrow();
    expect(await readGenerated()).toBe('s');
    const [{ triggers }] = await dataSource.query(
      `SELECT count(*)::int AS triggers FROM pg_trigger t JOIN pg_class c ON c.oid = t.tgrelid JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = $1 AND NOT t.tgisinternal`,
      [SCHEMA],
    );
    expect(triggers).toBe(0);
  });

  const countTriggers = async (): Promise<number> => {
    const [{ triggers }] = await dataSource.query(
      `SELECT count(*)::int AS triggers FROM pg_trigger t JOIN pg_class c ON c.oid = t.tgrelid JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = $1 AND NOT t.tgisinternal`,
      [SCHEMA],
    );

    return triggers;
  };

  it('rolls back on an empty table when the trigger expression is broken', async () => {
    await dataSource.query(`TRUNCATE "${SCHEMA}"."person"`);

    await expect(
      service.convertTable({
        schemaName: SCHEMA,
        tableName: 'person',
        leanColumnExpression,
        triggerRowExpression: `to_tsvector('simple', COALESCE((NEW."doesNotExist"), ''))`,
        dryRun: false,
      }),
    ).rejects.toThrow();
    expect(await readGenerated()).toBe('s');
    expect(await countTriggers()).toBe(0);
  });

  it('re-creates a missing trigger on an already plain column', async () => {
    await convert(false);
    const [{ tgname }] = await dataSource.query(
      `SELECT t.tgname FROM pg_trigger t JOIN pg_class c ON c.oid = t.tgrelid JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = $1 AND NOT t.tgisinternal`,
      [SCHEMA],
    );
    await dataSource.query(`DROP TRIGGER "${tgname}" ON "${SCHEMA}"."person"`);

    await expect(convert(false)).resolves.toEqual({
      status: 'alreadyConverted',
      mismatchCount: 0,
    });
    expect(await countTriggers()).toBe(1);

    await dataSource.query(
      `UPDATE "${SCHEMA}"."person" SET "jobTitle" = 'Chief Hacker' WHERE "nameFirstName" = 'Samuel'`,
    );
    const [{ hackers }] = await dataSource.query(
      `SELECT count(*)::int AS hackers FROM "${SCHEMA}"."person" WHERE "searchVector" @@ to_tsquery('simple', 'hacker')`,
    );
    expect(hackers).toBe(1);
  });

  it('refuses a plain column with no trigger whose stored vectors are NULL', async () => {
    await dataSource.query(
      `ALTER TABLE "${SCHEMA}"."person" ALTER COLUMN "searchVector" DROP EXPRESSION`,
    );
    await dataSource.query(
      `UPDATE "${SCHEMA}"."person" SET "searchVector" = NULL`,
    );

    await expect(convert(true)).resolves.toEqual({
      status: 'mismatch',
      mismatchCount: 2,
    });
    await expect(convert(false)).resolves.toEqual({
      status: 'mismatch',
      mismatchCount: 2,
    });
    expect(await countTriggers()).toBe(0);
    const [{ nullVectors }] = await dataSource.query(
      `SELECT count(*)::int AS "nullVectors" FROM "${SCHEMA}"."person" WHERE "searchVector" IS NULL`,
    );
    expect(nullVectors).toBe(2);
  });

  it('rechecks a trigger-less plain column under a write lock before installing', async () => {
    await dataSource.query(
      `ALTER TABLE "${SCHEMA}"."person" ALTER COLUMN "searchVector" DROP EXPRESSION`,
    );
    const createQueryRunner = dataSource.createQueryRunner.bind(dataSource);
    const createQueryRunnerSpy = jest
      .spyOn(dataSource, 'createQueryRunner')
      .mockImplementation(() => {
        const queryRunner = createQueryRunner();
        const query = queryRunner.query.bind(queryRunner);

        // A concurrent write lands after the unlocked scan and before the lock.
        queryRunner.query = async (sql: string, parameters?: unknown[]) => {
          if (sql.startsWith('LOCK TABLE')) {
            await dataSource.query(
              `UPDATE "${SCHEMA}"."person" SET "jobTitle" = 'Changed', "searchVector" = NULL WHERE "nameFirstName" = 'Samuel'`,
            );
          }

          return query(sql, parameters);
        };

        return queryRunner;
      });

    try {
      await expect(convert(false)).resolves.toEqual({
        status: 'mismatch',
        mismatchCount: 1,
      });
    } finally {
      createQueryRunnerSpy.mockRestore();
    }
    expect(await countTriggers()).toBe(0);
  });

  it('throws when the searchVector column is missing', async () => {
    await dataSource.query(
      `ALTER TABLE "${SCHEMA}"."person" DROP COLUMN "searchVector"`,
    );

    await expect(convert(false)).rejects.toThrow(
      'searchVector column not found',
    );
  });

  it('returns lockTimeout when another session holds a conflicting lock', async () => {
    const lockRunner = dataSource.createQueryRunner();

    try {
      await lockRunner.connect();
      await lockRunner.query('BEGIN');
      await lockRunner.query(
        `LOCK TABLE "${SCHEMA}"."person" IN ACCESS SHARE MODE`,
      );

      await expect(
        service.convertTable({
          schemaName: SCHEMA,
          tableName: 'person',
          leanColumnExpression,
          triggerRowExpression,
          dryRun: false,
          lockTimeout: '200ms',
        }),
      ).resolves.toEqual({ status: 'lockTimeout', mismatchCount: 0 });
      expect(await readGenerated()).toBe('s');
    } finally {
      await lockRunner.query('ROLLBACK');
      await lockRunner.release();
    }
  });
});

const RICH_SCHEMA = 'search_vector_conversion_rich_test';

const richFields: FieldTypeAndNameMetadata[] = [
  { name: 'id', type: FieldMetadataType.UUID },
  { name: 'name', type: FieldMetadataType.FULL_NAME },
  { name: 'emails', type: FieldMetadataType.EMAILS },
  { name: 'phones', type: FieldMetadataType.PHONES },
  { name: 'links', type: FieldMetadataType.LINKS },
  { name: 'jobTitle', type: FieldMetadataType.TEXT },
  {
    name: 'stage',
    type: FieldMetadataType.SELECT,
    options: [
      { value: 'NEW', label: 'Nouveau Été', position: 0 },
      { value: 'WON', label: "Won't lose", position: 1 },
    ],
  },
  {
    name: 'tags',
    type: FieldMetadataType.MULTI_SELECT,
    options: [
      { value: 'HOT', label: 'Chaud', position: 0 },
      { value: 'COLD', label: 'Froid ❄', position: 1 },
    ],
  },
  { name: 'address', type: FieldMetadataType.ADDRESS },
  { name: 'bodyV2', type: FieldMetadataType.RICH_TEXT },
  // Option-less dropdowns project a constant '', so they need no column.
  { name: 'priority', type: FieldMetadataType.SELECT, options: [] },
  { name: 'labels', type: FieldMetadataType.MULTI_SELECT, options: [] },
];

// 100 text columns plus phones (6 pieces) forces the nested concat_ws path.
const wideFields: FieldTypeAndNameMetadata[] = [
  ...Array.from(
    { length: 100 },
    (_, index): FieldTypeAndNameMetadata => ({
      name: `text${index}`,
      type: FieldMetadataType.TEXT,
    }),
  ),
  { name: 'phones', type: FieldMetadataType.PHONES },
];

describe('SearchVectorTriggerConversionService.convertTable with every searchable type', () => {
  let dataSource: DataSource;
  let service: SearchVectorTriggerConversionService;

  const expressionsFor = (tableFields: FieldTypeAndNameMetadata[]) => ({
    generated: getTsVectorColumnExpressionFromFields(tableFields),
    leanColumnExpression: getLeanTsVectorExpressionFromFields(tableFields, {
      columnReference: 'column',
    }),
    triggerRowExpression: getLeanTsVectorExpressionFromFields(tableFields, {
      columnReference: 'triggerRow',
    }),
  });

  const countDistinctFromLean = async (
    tableName: string,
    leanColumnExpression: string,
    whereClause = 'TRUE',
  ): Promise<number> => {
    const [{ distinctCount }] = await dataSource.query(
      `SELECT count(*) FILTER (WHERE "searchVector" IS DISTINCT FROM (${leanColumnExpression}))::int AS "distinctCount"
         FROM "${RICH_SCHEMA}"."${tableName}" WHERE ${whereClause}`,
    );

    return distinctCount;
  };

  beforeAll(async () => {
    dataSource = new DataSource({
      type: 'postgres',
      url: process.env.PG_DATABASE_URL,
      synchronize: false,
    });
    await dataSource.initialize();
    service = new SearchVectorTriggerConversionService(dataSource, {
      getOrRecompute: jest.fn(),
    } as never);
  });

  beforeEach(async () => {
    await dataSource.query(`DROP SCHEMA IF EXISTS "${RICH_SCHEMA}" CASCADE`);
    await dataSource.query(`CREATE SCHEMA "${RICH_SCHEMA}"`);
  });

  afterAll(async () => {
    if (dataSource?.isInitialized) {
      try {
        await dataSource.query(
          `DROP SCHEMA IF EXISTS "${RICH_SCHEMA}" CASCADE`,
        );
      } finally {
        await dataSource.destroy();
      }
    }
  });

  it('converts enum, array, composite and uuid columns and keeps written rows equal to the lean formula', async () => {
    const { generated, leanColumnExpression, triggerRowExpression } =
      expressionsFor(richFields);

    await dataSource.query(
      `CREATE TYPE "${RICH_SCHEMA}"."stage_enum" AS ENUM ('NEW', 'WON')`,
    );
    await dataSource.query(
      `CREATE TYPE "${RICH_SCHEMA}"."tags_enum" AS ENUM ('HOT', 'COLD')`,
    );
    await dataSource.query(`CREATE TABLE "${RICH_SCHEMA}"."opportunity" (
      "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      "nameFirstName" text, "nameLastName" text,
      "emailsPrimaryEmail" text, "emailsAdditionalEmails" jsonb,
      "phonesPrimaryPhoneNumber" text, "phonesPrimaryPhoneCallingCode" text,
      "phonesAdditionalPhones" jsonb,
      "linksPrimaryLinkLabel" text, "linksPrimaryLinkUrl" text, "linksSecondaryLinks" jsonb,
      "jobTitle" text,
      "stage" "${RICH_SCHEMA}"."stage_enum",
      "tags" "${RICH_SCHEMA}"."tags_enum"[],
      "addressAddressStreet1" text, "addressAddressStreet2" text, "addressAddressCity" text,
      "addressAddressPostcode" text, "addressAddressState" text, "addressAddressCountry" text,
      "bodyV2Markdown" text,
      "searchVector" tsvector GENERATED ALWAYS AS (${generated}) STORED
    )`);
    await dataSource.query(`INSERT INTO "${RICH_SCHEMA}"."opportunity"
      ("nameFirstName","nameLastName","emailsPrimaryEmail","emailsAdditionalEmails",
       "phonesPrimaryPhoneNumber","phonesPrimaryPhoneCallingCode","phonesAdditionalPhones",
       "linksPrimaryLinkLabel","linksPrimaryLinkUrl","linksSecondaryLinks",
       "jobTitle","stage","tags",
       "addressAddressStreet1","addressAddressCity","addressAddressCountry","bodyV2Markdown") VALUES
      ('José','Müller','jose.muller@café.de','["p.iyer@gmail.com","o''neil@x.io"]','4155550100','+1','[{"number":"2025550199","countryCode":"US","callingCode":"+1"}]','Lïnk','https://ex.com/Pàge','[{"url":"https://two.io","label":"Sécond"}]','Directeur Général','NEW','{HOT,COLD}','12 Rue de l''Été','Zürich','Suisse','**Réunion** _prévue_'),
      ('O''Brien','D''Arcy','','[]','','','[]','','','[]','"Quoted" title','WON','{}','','','',''),
      (NULL,NULL,NULL,NULL,NULL,NULL,NULL,NULL,NULL,NULL,NULL,NULL,NULL,NULL,NULL,NULL,NULL),
      ('Zoë',NULL,'zoe@ex.com',NULL,NULL,'+44',NULL,NULL,'ex.com',NULL,'Ingénieure',NULL,'{COLD}',NULL,'São Paulo',NULL,'# Notes')`);

    expect(
      await countDistinctFromLean('opportunity', leanColumnExpression),
    ).toBe(0);

    const before = await dataSource.query(
      `SELECT id, "searchVector"::text AS v FROM "${RICH_SCHEMA}"."opportunity" ORDER BY id`,
    );

    await expect(
      service.convertTable({
        schemaName: RICH_SCHEMA,
        tableName: 'opportunity',
        leanColumnExpression,
        triggerRowExpression,
        dryRun: false,
      }),
    ).resolves.toEqual({ status: 'converted', mismatchCount: 0 });

    const after = await dataSource.query(
      `SELECT id, "searchVector"::text AS v FROM "${RICH_SCHEMA}"."opportunity" ORDER BY id`,
    );

    expect(after).toEqual(before);

    await dataSource.query(
      `UPDATE "${RICH_SCHEMA}"."opportunity"
          SET "jobTitle" = 'Chef d''équipe', "tags" = '{HOT}', "stage" = 'WON',
              "emailsAdditionalEmails" = '["nouveau@été.fr"]'
        WHERE "nameFirstName" = 'José'`,
    );
    await dataSource.query(
      `INSERT INTO "${RICH_SCHEMA}"."opportunity"
        ("nameFirstName","phonesPrimaryPhoneNumber","phonesPrimaryPhoneCallingCode","linksSecondaryLinks","stage","tags")
        VALUES ('Ångström','7700900123','+44','[{"url":"https://a.io","label":"Ä"}]','NEW','{COLD,HOT}')`,
    );

    const [{ written, writtenDistinct }] = await dataSource.query(
      `SELECT count(*)::int AS written,
              count(*) FILTER (WHERE NOT ("searchVector" IS NOT DISTINCT FROM (${leanColumnExpression})))::int AS "writtenDistinct"
         FROM "${RICH_SCHEMA}"."opportunity"
        WHERE "nameFirstName" IN ('José', 'Ångström')`,
    );

    expect(written).toBe(2);
    expect(writtenDistinct).toBe(0);
    expect(
      await countDistinctFromLean('opportunity', leanColumnExpression),
    ).toBe(0);
  });

  it('runs the nested concat_ws path past 99 pieces and matches the generated column', async () => {
    const { generated, leanColumnExpression, triggerRowExpression } =
      expressionsFor(wideFields);

    expect(leanColumnExpression.match(/concat_ws\(' ', /g)).toHaveLength(3);

    const textColumns = Array.from(
      { length: 100 },
      (_, index) => `"text${index}" text`,
    ).join(', ');

    await dataSource.query(`CREATE TABLE "${RICH_SCHEMA}"."wide" (
      "id" serial PRIMARY KEY, ${textColumns},
      "phonesPrimaryPhoneNumber" text, "phonesPrimaryPhoneCallingCode" text,
      "phonesAdditionalPhones" jsonb,
      "searchVector" tsvector GENERATED ALWAYS AS (${generated}) STORED
    )`);
    await dataSource.query(
      `INSERT INTO "${RICH_SCHEMA}"."wide" ("text0", "text57", "text99", "phonesPrimaryPhoneNumber", "phonesPrimaryPhoneCallingCode")
       VALUES ('Élan', NULL, 'dernier mot', '4155550100', '+1'), (NULL, 'milieu', NULL, NULL, NULL)`,
    );

    expect(await countDistinctFromLean('wide', leanColumnExpression)).toBe(0);

    await expect(
      service.convertTable({
        schemaName: RICH_SCHEMA,
        tableName: 'wide',
        leanColumnExpression,
        triggerRowExpression,
        dryRun: false,
      }),
    ).resolves.toEqual({ status: 'converted', mismatchCount: 0 });

    await dataSource.query(
      `UPDATE "${RICH_SCHEMA}"."wide" SET "text98" = 'avant-dernier' WHERE "text57" = 'milieu'`,
    );

    expect(await countDistinctFromLean('wide', leanColumnExpression)).toBe(0);
    const [{ matches }] = await dataSource.query(
      `SELECT count(*)::int AS matches FROM "${RICH_SCHEMA}"."wide" WHERE "searchVector" @@ to_tsquery('simple', 'dernier')`,
    );

    expect(matches).toBe(2);
  });
});
