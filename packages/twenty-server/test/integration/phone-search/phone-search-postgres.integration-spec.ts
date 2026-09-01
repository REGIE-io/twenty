import { config } from 'dotenv';
import { DataSource, type QueryRunner } from 'typeorm';

import { AddPhoneSearchTokensFastInstanceCommand } from 'src/database/commands/upgrade-version-command/2-32/2-32-instance-command-fast-1786800000000-add-phone-search-tokens';

jest.useRealTimers();

config({
  path: process.env.NODE_ENV === 'test' ? '.env.test' : '.env',
  override: true,
});

const FIELD_ONE = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const FIELD_TWO = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const FIELD_THREE = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
const fieldToken = (field: string, digits: string) =>
  `f${field.replace(/-/g, '')}p${digits}`;

describe('phone search PostgreSQL contracts', () => {
  let dataSource: DataSource;

  beforeAll(async () => {
    dataSource = new DataSource({
      type: 'postgres',
      url: process.env.PG_DATABASE_URL,
      synchronize: false,
    });
    await dataSource.initialize();

    const queryRunner = dataSource.createQueryRunner();

    try {
      await new AddPhoneSearchTokensFastInstanceCommand().up(queryRunner);
    } finally {
      await queryRunner.release();
    }
  });

  afterAll(async () => {
    await dataSource?.destroy();
  });

  describe('public.phone_search_tokens', () => {
    const callHelper = async ({
      field = FIELD_ONE,
      callingCode = null,
      number = null,
      additional = null,
    }: {
      field?: string;
      callingCode?: string | null;
      number?: string | null;
      additional?: unknown;
    }) => {
      const [{ tokens }] = await dataSource.query(
        'SELECT public.phone_search_tokens($1, $2, $3, $4::jsonb) AS tokens',
        [
          field,
          callingCode,
          number,
          additional === null ? null : JSON.stringify(additional),
        ],
      );

      return tokens as string | null;
    };

    it.each([
      ['all null', {}, null],
      ['primary calling code only', { callingCode: '+1' }, null],
      ['primary number only', { number: '4155551000' }, null],
      ['empty additional array', { additional: [] }, null],
      ['malformed additional object', { additional: {} }, null],
      [
        'malformed additional entries',
        {
          additional: [
            null,
            {},
            { callingCode: '+1' },
            { number: '4155551001' },
            { callingCode: '+x', number: '4155551001' },
          ],
        },
        null,
      ],
      [
        'malformed primary calling code',
        { callingCode: '1', number: '4155551000' },
        null,
      ],
      [
        'malformed primary number',
        { callingCode: '+1', number: '415 555 1000' },
        null,
      ],
    ])('returns null for %s', async (_name, input, expected) => {
      await expect(callHelper(input)).resolves.toBe(expected);
    });

    it('emits a field-qualified canonical primary token', async () => {
      await expect(
        callHelper({ callingCode: '+1', number: '4155551000' }),
      ).resolves.toBe(fieldToken(FIELD_ONE, '14155551000'));
    });

    it('emits multiple additional phones with different calling codes and skips malformed residual data', async () => {
      await expect(
        callHelper({
          additional: [
            { callingCode: '+44', number: '2071838750' },
            { callingCode: '+33', number: '145555501' },
            { callingCode: '+44x', number: '2071838750' },
            { callingCode: '+44', number: '20-7183-8750' },
          ],
        }),
      ).resolves.toBe(
        `${fieldToken(FIELD_ONE, '442071838750')} ${fieldToken(FIELD_ONE, '33145555501')}`,
      );
    });

    it('allows harmless duplicate lexemes for duplicate phone values', async () => {
      const token = fieldToken(FIELD_ONE, '14155551002');

      await expect(
        callHelper({
          callingCode: '+1',
          number: '4155551002',
          additional: [{ callingCode: '+1', number: '4155551002' }],
        }),
      ).resolves.toBe(`${token} ${token}`);
    });

    it('keeps equal digits under distinct immutable field keys distinct', async () => {
      const first = await callHelper({
        field: FIELD_ONE,
        callingCode: '+1',
        number: '4155551003',
      });
      const second = await callHelper({
        field: FIELD_TWO,
        callingCode: '+1',
        number: '4155551003',
      });

      expect(first).toBe(fieldToken(FIELD_ONE, '14155551003'));
      expect(second).toBe(fieldToken(FIELD_TWO, '14155551003'));
      expect(first).not.toBe(second);
    });
  });

  describe('stored generated vector and GIN index', () => {
    let tempTableRunner: QueryRunner;

    beforeEach(async () => {
      tempTableRunner = dataSource.createQueryRunner();
      await tempTableRunner.connect();
      await tempTableRunner.query(`
        CREATE TEMPORARY TABLE phone_search_person (
          id integer GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
          "phonesPrimaryPhoneCallingCode" text,
          "phonesPrimaryPhoneNumber" text,
          "phonesAdditionalPhones" jsonb,
          "customOnePrimaryPhoneCallingCode" text,
          "customOnePrimaryPhoneNumber" text,
          "customOneAdditionalPhones" jsonb,
          "customTwoPrimaryPhoneCallingCode" text,
          "customTwoPrimaryPhoneNumber" text,
          "customTwoAdditionalPhones" jsonb,
          "phoneSearchVector" tsvector GENERATED ALWAYS AS (
            to_tsvector('simple',
              COALESCE(public.phone_search_tokens('${FIELD_ONE}', "phonesPrimaryPhoneCallingCode", "phonesPrimaryPhoneNumber", "phonesAdditionalPhones"), '') || ' ' ||
              COALESCE(public.phone_search_tokens('${FIELD_TWO}', "customOnePrimaryPhoneCallingCode", "customOnePrimaryPhoneNumber", "customOneAdditionalPhones"), '') || ' ' ||
              COALESCE(public.phone_search_tokens('${FIELD_THREE}', "customTwoPrimaryPhoneCallingCode", "customTwoPrimaryPhoneNumber", "customTwoAdditionalPhones"), '')
            )
          ) STORED
        )
      `);
      await tempTableRunner.query(
        'CREATE INDEX phone_search_person_vector_gin ON phone_search_person USING GIN ("phoneSearchVector")',
      );
    });

    afterEach(async () => {
      if (!tempTableRunner) return;
      await tempTableRunner.query('DROP TABLE IF EXISTS phone_search_person');
      await tempTableRunner.release();
    });

    const findIds = async (query: string) => {
      const rows = await tempTableRunner.query(
        `SELECT id FROM phone_search_person
          WHERE "phoneSearchVector" @@ to_tsquery('simple', $1)
          ORDER BY id`,
        [query],
      );

      return rows.map(({ id }: { id: number }) => id);
    };

    it('indexes sparse standard/custom combinations and multiple custom fields', async () => {
      const [{ id: customOnlyId }] = await tempTableRunner.query(
        `INSERT INTO phone_search_person
          ("customOnePrimaryPhoneCallingCode", "customOnePrimaryPhoneNumber")
         VALUES ('+1', '4155551100') RETURNING id`,
      );
      const [{ id: standardOnlyId }] = await tempTableRunner.query(
        `INSERT INTO phone_search_person
          ("phonesPrimaryPhoneCallingCode", "phonesPrimaryPhoneNumber")
         VALUES ('+44', '2071838750') RETURNING id`,
      );
      const [{ id: twoCustomId }] = await tempTableRunner.query(
        `INSERT INTO phone_search_person
          ("customOneAdditionalPhones", "customTwoPrimaryPhoneCallingCode", "customTwoPrimaryPhoneNumber")
         VALUES ($1::jsonb, '+33', '145555501') RETURNING id`,
        [JSON.stringify([{ callingCode: '+1', number: '4155551101' }])],
      );

      await expect(
        findIds(fieldToken(FIELD_TWO, '14155551100')),
      ).resolves.toEqual([customOnlyId]);
      await expect(
        findIds(fieldToken(FIELD_ONE, '442071838750')),
      ).resolves.toEqual([standardOnlyId]);
      await expect(
        findIds(fieldToken(FIELD_TWO, '14155551101')),
      ).resolves.toEqual([twoCustomId]);
      await expect(
        findIds(fieldToken(FIELD_THREE, '33145555501')),
      ).resolves.toEqual([twoCustomId]);
    });

    it('updates primary and additional matches inside the writing transaction', async () => {
      const [{ id }] = await tempTableRunner.query(
        `INSERT INTO phone_search_person
          ("phonesPrimaryPhoneCallingCode", "phonesPrimaryPhoneNumber", "phonesAdditionalPhones")
         VALUES ('+1', '4155551200', $1::jsonb) RETURNING id`,
        [JSON.stringify([{ callingCode: '+1', number: '4155551201' }])],
      );
      await tempTableRunner.startTransaction();
      try {
        await expect(
          tempTableRunner.query(
            `SELECT id FROM phone_search_person WHERE "phoneSearchVector" @@ to_tsquery('simple', $1)`,
            [fieldToken(FIELD_ONE, '14155551200')],
          ),
        ).resolves.toEqual([{ id }]);
        await tempTableRunner.query(
          `UPDATE phone_search_person SET
            "phonesPrimaryPhoneNumber" = '4155551202',
            "phonesAdditionalPhones" = $1::jsonb
           WHERE id = $2`,
          [JSON.stringify([{ callingCode: '+1', number: '4155551203' }]), id],
        );
        await expect(
          tempTableRunner.query(
            `SELECT id FROM phone_search_person WHERE "phoneSearchVector" @@ to_tsquery('simple', $1)`,
            [fieldToken(FIELD_ONE, '14155551200')],
          ),
        ).resolves.toEqual([]);
        await expect(
          tempTableRunner.query(
            `SELECT id FROM phone_search_person WHERE "phoneSearchVector" @@ to_tsquery('simple', $1)`,
            [fieldToken(FIELD_ONE, '14155551202')],
          ),
        ).resolves.toEqual([{ id }]);
        await expect(
          tempTableRunner.query(
            `SELECT id FROM phone_search_person WHERE "phoneSearchVector" @@ to_tsquery('simple', $1)`,
            [fieldToken(FIELD_ONE, '14155551203')],
          ),
        ).resolves.toEqual([{ id }]);
      } finally {
        await tempTableRunner.rollbackTransaction();
      }
    });

    it.each([
      ['hit', fieldToken(FIELD_ONE, '14155551333')],
      ['miss', fieldToken(FIELD_ONE, '14155559999')],
    ])(
      'uses the GIN index for an exact qualified %s query',
      async (_case, token) => {
        await tempTableRunner.query(
          `INSERT INTO phone_search_person
          ("phonesPrimaryPhoneCallingCode", "phonesPrimaryPhoneNumber")
         SELECT '+1', (4155550000 + value)::text
         FROM generate_series(1, 2500) AS value`,
        );
        await tempTableRunner.query('ANALYZE phone_search_person');
        await tempTableRunner.query('SET enable_seqscan = off');

        try {
          const [{ 'QUERY PLAN': plan }] = await tempTableRunner.query(
            `EXPLAIN (FORMAT JSON)
           SELECT id FROM phone_search_person
           WHERE "phoneSearchVector" @@ to_tsquery('simple', $1)`,
            [token],
          );
          const serializedPlan = JSON.stringify(plan);

          expect(serializedPlan).toContain('phone_search_person_vector_gin');
          expect(serializedPlan).toMatch(/Bitmap Index Scan|Index Scan/);
        } finally {
          await tempTableRunner.query('RESET enable_seqscan');
        }
      },
    );
  });

  it('defines a reversible instance upgrade for the helper and three-column uniqueness constraint', async () => {
    const up = jest.fn().mockResolvedValue(undefined);
    const down = jest.fn().mockResolvedValue(undefined);

    await new AddPhoneSearchTokensFastInstanceCommand().up({
      query: up,
    } as unknown as QueryRunner);
    await new AddPhoneSearchTokensFastInstanceCommand().down({
      query: down,
    } as unknown as QueryRunner);

    expect(up.mock.calls.flat().join('\n')).toContain(
      '"objectMetadataId", "fieldMetadataId", "tsVectorFieldMetadataId"',
    );
    expect(up.mock.calls.flat().join('\n')).toContain(
      'CREATE OR REPLACE FUNCTION public.phone_search_tokens',
    );
    expect(down.mock.calls.flat().join('\n')).toContain(
      'DROP FUNCTION IF EXISTS public.phone_search_tokens',
    );
    expect(down.mock.calls.flat().join('\n')).toContain(
      'UNIQUE ("objectMetadataId", "fieldMetadataId")',
    );
  });
});
