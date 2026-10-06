import { createOneFieldMetadata } from 'test/integration/metadata/suites/field-metadata/utils/create-one-field-metadata.util';
import { deleteOneFieldMetadata } from 'test/integration/metadata/suites/field-metadata/utils/delete-one-field-metadata.util';
import { updateOneFieldMetadata } from 'test/integration/metadata/suites/field-metadata/utils/update-one-field-metadata.util';
import { findManyObjectMetadata } from 'test/integration/metadata/suites/object-metadata/utils/find-many-object-metadata.util';
import { makeRestAPIRequest } from 'test/integration/rest/utils/make-rest-api-request.util';
import { jestExpectToBeDefined } from 'test/utils/jest-expect-to-be-defined.util.test';
import { FieldMetadataType } from 'twenty-shared/types';

// crm provisioning creates its external-id indexes in one request, so they share one
// workspace migration instead of paying a cache rebuild each.
const TEST_SCHEMA_NAME = 'workspace_1wgvd1injqtife6y4rvfbu3h5';
const FIELD_NAMES = ['batchIndexFirstToken', 'batchIndexSecondToken'];

const readCompanyBtreeIndexDefinitions = async (): Promise<string[]> => {
  const rows: { indexdef: string }[] = await global.testDataSource.query(
    `SELECT indexdef FROM pg_indexes WHERE schemaname = $1 AND tablename = 'company'`,
    [TEST_SCHEMA_NAME],
  );

  return rows
    .map((row) => row.indexdef)
    .filter((indexdef) =>
      FIELD_NAMES.some((name) => indexdef.includes(`"${name}"`)),
    );
};

describe('Index metadata batch create', () => {
  let companyObjectMetadataId: string;
  const fieldMetadataIds: string[] = [];

  beforeAll(async () => {
    const { objects } = await findManyObjectMetadata({
      expectToFail: false,
      input: { filter: {}, paging: { first: 100 } },
      gqlFields: `id nameSingular`,
    });
    const company = objects.find((object) => object.nameSingular === 'company');

    jestExpectToBeDefined(company);
    companyObjectMetadataId = company.id;

    for (const name of FIELD_NAMES) {
      const {
        data: {
          createOneField: { id },
        },
      } = await createOneFieldMetadata({
        expectToFail: false,
        input: {
          name,
          label: name,
          type: FieldMetadataType.TEXT,
          objectMetadataId: companyObjectMetadataId,
          isLabelSyncedWithName: false,
        },
        gqlFields: `id`,
      });

      fieldMetadataIds.push(id);
    }
  });

  afterAll(async () => {
    for (const fieldMetadataId of fieldMetadataIds) {
      await updateOneFieldMetadata({
        expectToFail: false,
        gqlFields: `id`,
        input: {
          idToUpdate: fieldMetadataId,
          updatePayload: { isActive: false },
        },
      });
      await deleteOneFieldMetadata({
        expectToFail: false,
        input: { idToDelete: fieldMetadataId },
      });
    }
  });

  it('rejects the same index twice in one batch and creates none of it', async () => {
    const index = {
      objectMetadataId: companyObjectMetadataId,
      fields: [{ fieldMetadataId: fieldMetadataIds[0] }],
      indexType: 'BTREE',
    };

    const response = await makeRestAPIRequest({
      method: 'post',
      path: '/metadata/indexes/batch',
      body: { indexes: [index, index] },
    });

    expect(response.status).toBeGreaterThanOrEqual(400);
    expect(await readCompanyBtreeIndexDefinitions()).toEqual([]);
  });

  it('creates every requested index in one request', async () => {
    const response = await makeRestAPIRequest({
      method: 'post',
      path: '/metadata/indexes/batch',
      body: {
        indexes: fieldMetadataIds.map((fieldMetadataId) => ({
          objectMetadataId: companyObjectMetadataId,
          fields: [{ fieldMetadataId }],
          indexType: 'BTREE',
        })),
      },
    });

    expect(response.status).toBeLessThan(300);
    expect(response.body.data).toHaveLength(2);
    expect(
      response.body.data.map(
        (index: { fields: { fieldMetadataId: string }[] }) =>
          index.fields[0].fieldMetadataId,
      ),
    ).toEqual(fieldMetadataIds);

    const indexDefinitions = await readCompanyBtreeIndexDefinitions();

    expect(indexDefinitions).toHaveLength(2);
    indexDefinitions.forEach((indexdef) => {
      expect(indexdef).toContain('USING btree');
      expect(indexdef).not.toContain('UNIQUE');
    });
  });
});
