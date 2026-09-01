import { faker } from '@faker-js/faker';
import { createOneOperation } from 'test/integration/graphql/utils/create-one-operation.util';
import { searchPeopleByPhone } from 'test/integration/graphql/utils/search-people-by-phone.util';
import { deleteRecordsByIds } from 'test/integration/utils/delete-records-by-ids';
import { STANDARD_OBJECTS } from 'twenty-shared/metadata';

import { SEED_APPLE_WORKSPACE_ID } from 'src/engine/workspace-manager/dev-seeder/core/constants/seeder-workspaces.constant';

const TEST_WORKSPACE_SCHEMA = 'workspace_1wgvd1injqtife6y4rvfbu3h5';

describe('fresh workspace Person phone-search provisioning', () => {
  const createdPersonIds: string[] = [];

  afterAll(async () => {
    await deleteRecordsByIds('person', createdPersonIds);
  });

  it('has standard vector, GIN index, dual standard-phone contributions, and stored physical DDL', async () => {
    const [person] = await global.testDataSource.query(
      `SELECT id FROM core."objectMetadata"
       WHERE "workspaceId" = $1 AND "universalIdentifier" = $2`,
      [SEED_APPLE_WORKSPACE_ID, STANDARD_OBJECTS.person.universalIdentifier],
    );
    const [vector] = await global.testDataSource.query(
      `SELECT id, name, type, "isSystem", "isActive", "isUIEditable"
       FROM core."fieldMetadata"
       WHERE "workspaceId" = $1 AND "objectMetadataId" = $2
         AND "universalIdentifier" = $3`,
      [
        SEED_APPLE_WORKSPACE_ID,
        person.id,
        STANDARD_OBJECTS.person.fields.phoneSearchVector.universalIdentifier,
      ],
    );
    expect(vector).toMatchObject({
      name: 'phoneSearchVector',
      type: 'TS_VECTOR',
      isSystem: true,
      isUIEditable: false,
    });

    const [index] = await global.testDataSource.query(
      `SELECT i.id, i."indexType", i."isSystemSideEffect", f."fieldMetadataId"
       FROM core."indexMetadata" i
       JOIN core."indexFieldMetadata" f ON f."indexMetadataId" = i.id
       WHERE i."workspaceId" = $1 AND i."universalIdentifier" = $2`,
      [
        SEED_APPLE_WORKSPACE_ID,
        STANDARD_OBJECTS.person.indexes.phoneSearchVectorGinIndex
          .universalIdentifier,
      ],
    );
    expect(index).toMatchObject({
      indexType: 'GIN',
      isSystemSideEffect: true,
      fieldMetadataId: vector.id,
    });

    const contributions = await global.testDataSource.query(
      `SELECT sf."tsVectorFieldMetadataId"
       FROM core."searchFieldMetadata" sf
       JOIN core."fieldMetadata" source ON source.id = sf."fieldMetadataId"
       WHERE sf."workspaceId" = $1 AND sf."objectMetadataId" = $2
         AND source."universalIdentifier" = $3`,
      [
        SEED_APPLE_WORKSPACE_ID,
        person.id,
        STANDARD_OBJECTS.person.fields.phones.universalIdentifier,
      ],
    );
    expect(contributions).toHaveLength(2);
    expect(
      contributions.map(
        (contribution: { tsVectorFieldMetadataId: string }) =>
          contribution.tsVectorFieldMetadataId,
      ),
    ).toContain(vector.id);

    const [column] = await global.testDataSource.query(
      `SELECT is_generated, generation_expression
       FROM information_schema.columns
       WHERE table_schema = $1 AND table_name = 'person'
         AND column_name = 'phoneSearchVector'`,
      [TEST_WORKSPACE_SCHEMA],
    );
    expect(column).toMatchObject({ is_generated: 'ALWAYS' });
    expect(column.generation_expression).toContain('phone_search_tokens');

    const [physicalIndex] = await global.testDataSource.query(
      `SELECT indexdef FROM pg_indexes
       WHERE schemaname = $1 AND tablename = 'person'
         AND indexdef ILIKE '%USING gin%phoneSearchVector%'`,
      [TEST_WORKSPACE_SCHEMA],
    );
    expect(physicalIndex?.indexdef).toContain('USING gin');
  });

  it('searches a standard phone immediately after record creation', async () => {
    const id = faker.string.uuid();
    const created = await createOneOperation({
      objectMetadataSingularName: 'person',
      input: {
        id,
        phones: {
          primaryPhoneNumber: '4155551300',
          primaryPhoneCallingCode: '+1',
          primaryPhoneCountryCode: 'US',
        },
      },
      gqlFields: 'id',
    });
    expect(created.errors).toBeUndefined();
    createdPersonIds.push(id);

    const found = await searchPeopleByPhone({
      phoneNumber: '+14155551300',
      limit: 10,
    });

    expect(found.errors).toBeUndefined();
    expect(
      found.data?.searchPeopleByPhone.edges.map(({ node }) => node.recordId),
    ).toEqual([id]);
  });

  it('enforces the three-column uniqueness contract', async () => {
    const [source] = await global.testDataSource.query(
      `SELECT sf.* FROM core."searchFieldMetadata" sf
       JOIN core."fieldMetadata" field ON field.id = sf."fieldMetadataId"
       WHERE sf."workspaceId" = $1
         AND field."universalIdentifier" = $2
       ORDER BY sf."tsVectorFieldMetadataId" LIMIT 1`,
      [
        SEED_APPLE_WORKSPACE_ID,
        STANDARD_OBJECTS.person.fields.phones.universalIdentifier,
      ],
    );

    expect(source).toBeDefined();
    await expect(
      global.testDataSource.query(
        `INSERT INTO core."searchFieldMetadata"
          (id, "universalIdentifier", "applicationId", "workspaceId",
           "objectMetadataId", "fieldMetadataId", "tsVectorFieldMetadataId",
           position, "isSystemSideEffect", "createdAt", "updatedAt")
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, now(), now())`,
        [
          faker.string.uuid(),
          faker.string.uuid(),
          source.applicationId,
          source.workspaceId,
          source.objectMetadataId,
          source.fieldMetadataId,
          source.tsVectorFieldMetadataId,
          source.position,
          source.isSystemSideEffect,
        ],
      ),
    ).rejects.toMatchObject({ code: '23505' });
  });
});
