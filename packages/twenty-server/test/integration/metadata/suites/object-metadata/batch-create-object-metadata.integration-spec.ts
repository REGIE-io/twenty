import { deleteOneObjectMetadata } from 'test/integration/metadata/suites/object-metadata/utils/delete-one-object-metadata.util';
import { findManyObjectMetadata } from 'test/integration/metadata/suites/object-metadata/utils/find-many-object-metadata.util';
import { getMockCreateObjectInput } from 'test/integration/metadata/suites/object-metadata/utils/generate-mock-create-object-metadata-input';
import { updateOneObjectMetadata } from 'test/integration/metadata/suites/object-metadata/utils/update-one-object-metadata.util';
import { makeRestAPIRequest } from 'test/integration/rest/utils/make-rest-api-request.util';

// crm provisioning creates its internal objects in one request, so they share one
// workspace migration instead of paying a cache rebuild each.
const TEST_SCHEMA_NAME = 'workspace_1wgvd1injqtife6y4rvfbu3h5';

const BATCH_OBJECTS = [
  getMockCreateObjectInput({
    nameSingular: 'batchFirstThing',
    namePlural: 'batchFirstThings',
    labelSingular: 'Batch first thing',
    labelPlural: 'Batch first things',
  }),
  getMockCreateObjectInput({
    nameSingular: 'batchSecondThing',
    namePlural: 'batchSecondThings',
    labelSingular: 'Batch second thing',
    labelPlural: 'Batch second things',
  }),
];

const findBatchObjects = async (): Promise<
  { id: string; nameSingular: string }[]
> => {
  const { objects } = await findManyObjectMetadata({
    expectToFail: false,
    input: { filter: {}, paging: { first: 1000 } },
    gqlFields: `id nameSingular`,
  });

  return objects.filter((object) =>
    BATCH_OBJECTS.some(
      ({ nameSingular }) => nameSingular === object.nameSingular,
    ),
  );
};

const readBatchTableNames = async (): Promise<string[]> => {
  const rows: { tablename: string }[] = await global.testDataSource.query(
    `SELECT tablename FROM pg_tables WHERE schemaname = $1 AND tablename = ANY($2) ORDER BY tablename`,
    [
      TEST_SCHEMA_NAME,
      BATCH_OBJECTS.map(({ nameSingular }) => `_${nameSingular}`),
    ],
  );

  return rows.map((row) => row.tablename);
};

describe('Object metadata batch create', () => {
  afterEach(async () => {
    for (const { id } of await findBatchObjects()) {
      await updateOneObjectMetadata({
        expectToFail: false,
        input: { idToUpdate: id, updatePayload: { isActive: false } },
      });
      await deleteOneObjectMetadata({
        expectToFail: false,
        input: { idToDelete: id },
      });
    }
  });

  it('rejects the same object twice in one batch and creates none of it', async () => {
    const response = await makeRestAPIRequest({
      method: 'post',
      path: '/metadata/objects/batch',
      body: { objects: [BATCH_OBJECTS[0], BATCH_OBJECTS[0]] },
    });

    expect(response.status).toBeGreaterThanOrEqual(400);
    expect(await findBatchObjects()).toEqual([]);
    expect(await readBatchTableNames()).toEqual([]);
  });

  it('creates every requested object, with its table and its own menu positions', async () => {
    const response = await makeRestAPIRequest({
      method: 'post',
      path: '/metadata/objects/batch',
      body: { objects: BATCH_OBJECTS },
    });

    expect(response.status).toBeLessThan(300);
    expect(
      response.body.data.map(
        (object: { nameSingular: string }) => object.nameSingular,
      ),
    ).toEqual(BATCH_OBJECTS.map(({ nameSingular }) => nameSingular));
    response.body.data.forEach((object: { fields: unknown[] }) => {
      expect(object.fields.length).toBeGreaterThan(0);
    });
    expect(await readBatchTableNames()).toEqual(
      BATCH_OBJECTS.map(({ nameSingular }) => `_${nameSingular}`).sort(),
    );

    const createdObjectIds = response.body.data.map(
      (object: { id: string }) => object.id,
    );
    const navigationPositions: { position: number }[] =
      await global.testDataSource.query(
        `SELECT position FROM core."navigationMenuItem" WHERE "targetObjectMetadataId" = ANY($1)`,
        [createdObjectIds],
      );

    expect(navigationPositions).toHaveLength(BATCH_OBJECTS.length);
    expect(
      new Set(navigationPositions.map(({ position }) => position)).size,
    ).toBe(BATCH_OBJECTS.length);
  });
});
