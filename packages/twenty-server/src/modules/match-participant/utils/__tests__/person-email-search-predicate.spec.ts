import { STANDARD_OBJECTS } from 'twenty-shared/metadata';
import { isDefined } from 'twenty-shared/utils';
import { DataSource, type SelectQueryBuilder } from 'typeorm';
import { v4 as uuid } from 'uuid';

import { getWorkspaceSchemaName } from 'src/engine/workspace-datasource/utils/get-workspace-schema-name.util';
import { computeTwentyStandardApplicationAllFlatEntityMaps } from 'src/engine/workspace-manager/twenty-standard-application/utils/twenty-standard-application-all-flat-entity-maps.constant';
import { addPersonEmailFiltersToQueryBuilder } from 'src/modules/match-participant/utils/add-person-email-filters-to-query-builder';
import { type PersonWorkspaceEntity } from 'src/modules/person/standard-objects/person.workspace-entity';

const LEGACY_PREDICATE = `(LOWER(TRIM("person"."emailsPrimaryEmail")) = ANY($1) OR EXISTS (
  SELECT 1 FROM jsonb_array_elements_text(
    CASE WHEN jsonb_typeof("person"."emailsAdditionalEmails") = 'array'
      THEN "person"."emailsAdditionalEmails" ELSE '[]'::jsonb END
  ) AS address(value) WHERE LOWER(TRIM(address.value)) = ANY($1)
))`;

// Stored values follow the write contract: lowercase and trimmed.
const SEEDED_PEOPLE: [string | null, string | null, boolean][] = [
  ['alice@example.com', null, false],
  [null, '["bob@example.com", "carol@example.com"]', false],
  ['', '{"dave@example.com": 1}', false],
  ['erin@example.com', '"frank@example.com"', false],
  ['heidi@example.com', '["heidi@example.com", "ivan@example.com"]', false],
  ['deleted@example.com', 'null', true],
  [null, '[]', false],
  [null, null, false],
];

const EMAIL_SETS = [
  ['alice@example.com'],
  [' Alice@Example.COM '],
  ['bob@example.com', 'carol@example.com'],
  ['dave@example.com', 'frank@example.com'],
  ['erin@example.com', 'heidi@example.com'],
  ['ivan@example.com', 'nobody@example.com'],
  ['deleted@example.com'],
  ['', '   '],
  [],
];

const standardFlatEntityMaps =
  computeTwentyStandardApplicationAllFlatEntityMaps({
    now: new Date().toISOString(),
    workspaceId: uuid(),
    twentyStandardApplicationId: uuid(),
  }).allFlatEntityMaps;
const findPersonEmailsIndexName = (subFieldName: string | null): string => {
  const index = Object.values(
    standardFlatEntityMaps.flatIndexMaps.byUniversalIdentifier,
  )
    .filter(isDefined)
    .find(({ universalFlatIndexFieldMetadatas }) =>
      universalFlatIndexFieldMetadatas.some(
        (indexField) =>
          indexField.fieldMetadataUniversalIdentifier ===
            STANDARD_OBJECTS.person.fields.emails.universalIdentifier &&
          indexField.subFieldName === subFieldName,
      ),
    );

  if (!isDefined(index)) {
    throw new Error(`Missing standard person emails index ${subFieldName}`);
  }

  return index.name;
};
const PRIMARY_EMAIL_INDEX_NAME = findPersonEmailsIndexName(null);
const ADDITIONAL_EMAILS_INDEX_NAME =
  findPersonEmailsIndexName('additionalEmails');

const integration = process.env.CRM_DUPLICATES_TEST_DATABASE_URL
  ? describe
  : describe.skip;

integration('person email search predicate against PostgreSQL', () => {
  const schemaName = getWorkspaceSchemaName(uuid());
  const personTable = `"${schemaName}"."person"`;
  let dataSource: DataSource;

  const buildQuery = (emails: string[]) =>
    addPersonEmailFiltersToQueryBuilder({
      queryBuilder: dataSource
        .createQueryBuilder()
        .select('"person"."id"', 'id')
        .from(
          `${schemaName}.person`,
          'person',
        ) as SelectQueryBuilder<PersonWorkspaceEntity>,
      emails,
    });
  const sortedIds = (rows: { id: string }[]) => rows.map(({ id }) => id).sort();

  beforeAll(async () => {
    jest.useRealTimers();
    dataSource = new DataSource({
      type: 'postgres',
      url: process.env.CRM_DUPLICATES_TEST_DATABASE_URL,
    });
    await dataSource.initialize();
    await dataSource.query(`CREATE SCHEMA "${schemaName}"`);
    await dataSource.query(
      `CREATE TABLE ${personTable} (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), "emailsPrimaryEmail" text, "emailsAdditionalEmails" jsonb, "deletedAt" timestamptz)`,
    );
    for (const [primaryEmail, additionalEmails, isDeleted] of SEEDED_PEOPLE) {
      await dataSource.query(
        `INSERT INTO ${personTable} ("emailsPrimaryEmail", "emailsAdditionalEmails", "deletedAt") VALUES ($1, $2::jsonb, CASE WHEN $3 THEN now() END)`,
        [primaryEmail, additionalEmails, isDeleted],
      );
    }
    await dataSource.query(
      `INSERT INTO ${personTable} ("emailsPrimaryEmail", "emailsAdditionalEmails")
       SELECT 'filler-' || n || '@example.test', jsonb_build_array('alt-' || n || '@example.test')
       FROM generate_series(1, 200000) n`,
    );
    await dataSource.query(
      `CREATE INDEX "${PRIMARY_EMAIL_INDEX_NAME}" ON ${personTable} ("emailsPrimaryEmail")`,
    );
    await dataSource.query(
      `CREATE INDEX "${ADDITIONAL_EMAILS_INDEX_NAME}" ON ${personTable} USING GIN ("emailsAdditionalEmails")`,
    );
    await dataSource.query(`ANALYZE ${personTable}`);
  }, 60_000);
  afterAll(async () => {
    await dataSource.query(`DROP SCHEMA "${schemaName}" CASCADE`);
    await dataSource.destroy();
  });

  it.each(EMAIL_SETS.map((emails) => [JSON.stringify(emails), emails]))(
    'matches the same people as the legacy predicate for %s',
    async (_label, emails) => {
      const queryBuilder = buildQuery(emails);
      const [, parameters] = queryBuilder.getQueryAndParameters();
      const legacyRows = await dataSource.query(
        `SELECT "person"."id" AS id FROM ${personTable} "person" WHERE ${LEGACY_PREDICATE}`,
        [parameters[0]],
      );

      expect(sortedIds(await queryBuilder.getRawMany())).toEqual(
        sortedIds(legacyRows),
      );
    },
  );

  it('finds primary and additional matches, including deleted people, but not object keys or scalars', async () => {
    const rows = await buildQuery([
      'alice@example.com',
      'carol@example.com',
      'deleted@example.com',
      'dave@example.com',
      'frank@example.com',
    ]).getRawMany();

    expect(rows).toHaveLength(3);
  });

  it('serves both halves from the standard person email indexes', async () => {
    const [query, parameters] = buildQuery([
      'alice@example.com',
      'ivan@example.com',
    ]).getQueryAndParameters();
    const plan = JSON.stringify(
      await dataSource.query(`EXPLAIN (FORMAT JSON) ${query}`, parameters),
    );

    expect(plan).toContain('BitmapOr');
    expect(plan).toContain(PRIMARY_EMAIL_INDEX_NAME);
    expect(plan).toContain(ADDITIONAL_EMAILS_INDEX_NAME);
    expect(plan).not.toContain('Seq Scan');
  });
});
