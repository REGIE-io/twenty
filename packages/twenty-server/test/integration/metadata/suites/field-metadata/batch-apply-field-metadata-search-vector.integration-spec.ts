import { createManyOperation } from 'test/integration/graphql/utils/create-many-operation.util';
import { search } from 'test/integration/graphql/utils/search.util';
import { createOneFieldMetadata } from 'test/integration/metadata/suites/field-metadata/utils/create-one-field-metadata.util';
import { deleteOneFieldMetadata } from 'test/integration/metadata/suites/field-metadata/utils/delete-one-field-metadata.util';
import { updateOneFieldMetadata } from 'test/integration/metadata/suites/field-metadata/utils/update-one-field-metadata.util';
import { findManyObjectMetadata } from 'test/integration/metadata/suites/object-metadata/utils/find-many-object-metadata.util';
import { makeRestAPIRequest } from 'test/integration/rest/utils/make-rest-api-request.util';
import { jestExpectToBeDefined } from 'test/utils/jest-expect-to-be-defined.util.test';
import {
  type AdditionalSearchSettings,
  FieldMetadataType,
} from 'twenty-shared/types';

import { type FieldMetadataDTO } from 'src/engine/metadata-modules/field-metadata/dtos/field-metadata.dto';

// crm provisioning marks company.linkedinLink searchable and creates searchable custom
// fields in the same step. batch-apply runs both as one migration, so the searchVector it
// rebuilds must index the same columns as the separate PATCH-then-create requests.
const TEST_SCHEMA_NAME = 'workspace_1wgvd1injqtife6y4rvfbu3h5';
const OBJECT_NAME_SINGULAR = 'company';
const OBJECT_NAME_PLURAL = 'companies';
const NEW_FIELD_NAME = 'batchApplySearchToken';
const NEW_FIELD_TOKEN = 'BatchApplyNewFieldToken77';

const searchableMarker: AdditionalSearchSettings = {
  additionalSearch: { version: 1, target: 'account', searchable: true },
};

const readSearchVectorExpression = async (): Promise<string> => {
  const [row]: { generation_expression: string }[] =
    await global.testDataSource.query(
      `SELECT generation_expression FROM information_schema.columns
       WHERE table_schema = $1 AND table_name = $2 AND column_name = 'searchVector'`,
      [TEST_SCHEMA_NAME, OBJECT_NAME_SINGULAR],
    );

  return row.generation_expression;
};

// Marked fields all take search position 0 and tie-break on a random identifier, so the
// column order inside the expression differs run to run on every path. Compare the set.
const indexedColumns = (expression: string): string[] =>
  [
    ...new Set(
      expression.match(/unaccent_immutable\(("?[A-Za-z]+"?)\)/g) ?? [],
    ),
  ].sort();

const deleteField = async (fieldMetadataId: string) => {
  await updateOneFieldMetadata({
    expectToFail: false,
    gqlFields: `id`,
    input: { idToUpdate: fieldMetadataId, updatePayload: { isActive: false } },
  });
  await deleteOneFieldMetadata({
    expectToFail: false,
    input: { idToDelete: fieldMetadataId },
  });
};

const newFieldInput = (objectMetadataId: string) => ({
  objectMetadataId,
  name: NEW_FIELD_NAME,
  label: 'Batch Apply Search Token',
  type: FieldMetadataType.TEXT,
  isLabelSyncedWithName: false,
  settings: searchableMarker,
});

describe('Field metadata batch-apply - search vector', () => {
  let companyObjectMetadataId: string;
  let linkedinField: FieldMetadataDTO;
  const createdFieldMetadataIds: string[] = [];

  const setLinkedinSettings = (settings: FieldMetadataDTO['settings']) =>
    updateOneFieldMetadata({
      expectToFail: false,
      gqlFields: `id settings`,
      input: { idToUpdate: linkedinField.id, updatePayload: { settings } },
    });

  beforeAll(async () => {
    const { objects } = await findManyObjectMetadata({
      expectToFail: false,
      input: { filter: {}, paging: { first: 100 } },
      gqlFields: `id nameSingular fieldsList { id name type settings }`,
    });
    const companyObject = objects.find(
      (object) => object.nameSingular === OBJECT_NAME_SINGULAR,
    );

    jestExpectToBeDefined(companyObject);
    companyObjectMetadataId = companyObject.id;

    const foundLinkedinField = companyObject.fieldsList?.find(
      (field: FieldMetadataDTO) => field.name === 'linkedinLink',
    );

    jestExpectToBeDefined(foundLinkedinField);
    linkedinField = foundLinkedinField;
  });

  afterAll(async () => {
    for (const fieldMetadataId of createdFieldMetadataIds) {
      await deleteField(fieldMetadataId);
    }
    await setLinkedinSettings(linkedinField.settings ?? null);
  });

  it('rebuilds the same searchVector as separate PATCH and create requests', async () => {
    await setLinkedinSettings({
      ...linkedinField.settings,
      ...searchableMarker,
    });
    const {
      data: {
        createOneField: { id: separatelyCreatedFieldId },
      },
    } = await createOneFieldMetadata({
      expectToFail: false,
      input: newFieldInput(companyObjectMetadataId),
      gqlFields: `id`,
    });
    const separateExpression = await readSearchVectorExpression();

    await deleteField(separatelyCreatedFieldId);
    await setLinkedinSettings(linkedinField.settings ?? null);

    const baselineExpression = await readSearchVectorExpression();

    const response = await makeRestAPIRequest({
      method: 'post',
      path: '/metadata/fields/batch-apply',
      body: {
        create: [newFieldInput(companyObjectMetadataId)],
        update: [
          {
            id: linkedinField.id,
            update: {
              settings: { ...linkedinField.settings, ...searchableMarker },
            },
          },
        ],
      },
    });

    expect(response.status).toBeLessThan(300);
    expect(response.body.created).toHaveLength(1);
    expect(response.body.created[0].name).toBe(NEW_FIELD_NAME);
    expect(response.body.updated).toHaveLength(1);
    expect(response.body.updated[0].id).toBe(linkedinField.id);
    expect(response.body.updated[0].settings).toMatchObject(searchableMarker);
    createdFieldMetadataIds.push(response.body.created[0].id);

    const batchExpression = await readSearchVectorExpression();

    expect(indexedColumns(batchExpression)).toEqual(
      indexedColumns(separateExpression),
    );
    expect(indexedColumns(batchExpression)).not.toEqual(
      indexedColumns(baselineExpression),
    );
    expect(batchExpression).toContain(`"${NEW_FIELD_NAME}"`);
    expect(batchExpression).toContain('"linkedinLinkPrimaryLinkUrl"');
  });

  it('finds a record by the new field after batch-apply', async () => {
    await createManyOperation({
      objectMetadataSingularName: OBJECT_NAME_SINGULAR,
      objectMetadataPluralName: OBJECT_NAME_PLURAL,
      gqlFields: `id ${NEW_FIELD_NAME}`,
      data: [
        { name: 'Batch Apply Search Co', [NEW_FIELD_NAME]: NEW_FIELD_TOKEN },
      ],
      expectToFail: false,
    });

    const result = await search({
      searchInput: NEW_FIELD_TOKEN,
      includedObjectNameSingulars: [OBJECT_NAME_SINGULAR],
      limit: 10,
      expectToFail: false,
    });

    expect(result.data.search.edges).toHaveLength(1);
  });

  it('rejects a batch that changes one field twice, and applies none of it', async () => {
    const expressionBefore = await readSearchVectorExpression();

    const response = await makeRestAPIRequest({
      method: 'post',
      path: '/metadata/fields/batch-apply',
      body: {
        create: [],
        update: [
          { id: linkedinField.id, update: { settings: searchableMarker } },
          {
            id: linkedinField.id,
            update: { settings: linkedinField.settings ?? null },
          },
        ],
      },
    });

    expect(response.status).toBe(400);
    expect(await readSearchVectorExpression()).toBe(expressionBefore);
  });
});
