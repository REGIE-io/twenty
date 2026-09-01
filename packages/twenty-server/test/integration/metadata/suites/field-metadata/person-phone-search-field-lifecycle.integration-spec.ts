import { faker } from '@faker-js/faker';
import { searchPeopleByPhone } from 'test/integration/graphql/utils/search-people-by-phone.util';
import { createOneOperation } from 'test/integration/graphql/utils/create-one-operation.util';
import { deleteRecordsByIds } from 'test/integration/utils/delete-records-by-ids';
import { createOneFieldMetadata } from 'test/integration/metadata/suites/field-metadata/utils/create-one-field-metadata.util';
import { deleteOneFieldMetadata } from 'test/integration/metadata/suites/field-metadata/utils/delete-one-field-metadata.util';
import { updateOneFieldMetadata } from 'test/integration/metadata/suites/field-metadata/utils/update-one-field-metadata.util';
import { makeMetadataAPIRequest } from 'test/integration/metadata/suites/utils/make-metadata-api-request.util';
import gql from 'graphql-tag';
import { STANDARD_OBJECTS } from 'twenty-shared/metadata';
import { FieldMetadataType } from 'twenty-shared/types';

import { SEED_APPLE_WORKSPACE_ID } from 'src/engine/workspace-manager/dev-seeder/core/constants/seeder-workspaces.constant';

jest.setTimeout(120000);

const runSuffix = `${Date.now()}${Math.floor(Math.random() * 10000)}`;
const logicalFieldName = `phoneSearchLifecycle${runSuffix}`;
const renamedFieldName = `renamedPhoneSearchLifecycle${runSuffix}`;
const createdPersonIds: string[] = [];
const createdFieldIds: string[] = [];
const TEST_WORKSPACE_SCHEMA = 'workspace_1wgvd1injqtife6y4rvfbu3h5';

const usPhone = (number: string) => ({
  primaryPhoneNumber: number,
  primaryPhoneCallingCode: '+1',
  primaryPhoneCountryCode: 'US',
});

const additionalUsPhone = (number: string) => ({
  number,
  callingCode: '+1',
  countryCode: 'US',
});

const expectPhoneSearchIds = async (
  phoneNumber: string,
  expectedIds: string[],
) => {
  const response = await searchPeopleByPhone({ phoneNumber, limit: 50 });

  expect(response.errors).toBeUndefined();
  expect(response.data).toBeDefined();
  expect(
    response.data?.searchPeopleByPhone.edges.map(({ node }) => node.recordId),
  ).toEqual(expectedIds);
};

describe('Person phone search custom-field lifecycle', () => {
  let personObjectMetadataId: string;
  let workspaceId: string;

  const getPhoneMetadataState = async (sourceFieldId?: string) => {
    const [vector] = await global.testDataSource.query(
      `SELECT id FROM core."fieldMetadata"
       WHERE "workspaceId" = $1 AND "objectMetadataId" = $2
         AND name = 'phoneSearchVector'`,
      [workspaceId, personObjectMetadataId],
    );
    const indexes = vector
      ? await global.testDataSource.query(
          `SELECT i.id FROM core."indexMetadata" i
           JOIN core."indexFieldMetadata" f ON f."indexMetadataId" = i.id
           WHERE i."workspaceId" = $1 AND i."objectMetadataId" = $2
             AND i."indexType" = 'GIN' AND f."fieldMetadataId" = $3`,
          [workspaceId, personObjectMetadataId, vector.id],
        )
      : [];
    const contributions =
      vector && sourceFieldId
        ? await global.testDataSource.query(
            `SELECT id, "universalIdentifier" FROM core."searchFieldMetadata"
             WHERE "workspaceId" = $1 AND "objectMetadataId" = $2
               AND "fieldMetadataId" = $3 AND "tsVectorFieldMetadataId" = $4`,
            [workspaceId, personObjectMetadataId, sourceFieldId, vector.id],
          )
        : [];
    const [column] = await global.testDataSource.query(
      `SELECT generation_expression FROM information_schema.columns
       WHERE table_schema = $1 AND table_name = 'person'
         AND column_name = 'phoneSearchVector'`,
      [TEST_WORKSPACE_SCHEMA],
    );

    return { vector, indexes, contributions, column };
  };

  beforeAll(async () => {
    const response = await makeMetadataAPIRequest({
      query: gql`
        query PersonObjectForPhoneSearchLifecycle {
          objects(paging: { first: 1000 }) {
            edges {
              node {
                id
                nameSingular
              }
            }
          }
        }
      `,
    });

    expect(response.body.errors).toBeUndefined();
    personObjectMetadataId = response.body.data.objects.edges.find(
      (edge: { node: { nameSingular: string } }) =>
        edge.node.nameSingular === 'person',
    )?.node.id;
    expect(personObjectMetadataId).toBeDefined();

    workspaceId = SEED_APPLE_WORKSPACE_ID;

    const initial = await getPhoneMetadataState();

    expect(initial.vector).toBeDefined();
    expect(initial.indexes).toHaveLength(1);
    const standardContributions = await global.testDataSource.query(
      `SELECT sf.id FROM core."searchFieldMetadata" sf
       JOIN core."fieldMetadata" source ON source.id = sf."fieldMetadataId"
       WHERE sf."workspaceId" = $1 AND sf."objectMetadataId" = $2
         AND sf."tsVectorFieldMetadataId" = $3
         AND source."universalIdentifier" = $4`,
      [
        workspaceId,
        personObjectMetadataId,
        initial.vector.id,
        STANDARD_OBJECTS.person.fields.phones.universalIdentifier,
      ],
    );
    expect(standardContributions).toHaveLength(1);
  }, 120000);

  afterAll(async () => {
    await deleteRecordsByIds('person', createdPersonIds);

    for (const fieldId of createdFieldIds.reverse()) {
      try {
        await updateOneFieldMetadata({
          input: { idToUpdate: fieldId, updatePayload: { isActive: false } },
          expectToFail: false,
        });
        await deleteOneFieldMetadata({
          input: { idToDelete: fieldId },
          expectToFail: false,
        });
      } catch {
        // Field creation may have failed before its metadata was persisted.
      }
    }
  }, 120000);

  it('updates phone-search participation through create, activate, rename, delete, and logical type transitions', async () => {
    const createPhonesField = async (name: string) => {
      const response = await createOneFieldMetadata({
        input: {
          name,
          label: name,
          type: FieldMetadataType.PHONES,
          objectMetadataId: personObjectMetadataId,
          isLabelSyncedWithName: false,
        },
        gqlFields: 'id',
        expectToFail: false,
      });
      const fieldId = response.data.createOneField.id;

      createdFieldIds.push(fieldId);
      return fieldId;
    };

    let fieldId = await createPhonesField(logicalFieldName);
    const afterCreate = await getPhoneMetadataState(fieldId);

    expect(afterCreate.vector).toBeDefined();
    expect(afterCreate.indexes).toHaveLength(1);
    expect(afterCreate.contributions).toHaveLength(1);
    expect(afterCreate.column.generation_expression).toContain(
      `${logicalFieldName}PrimaryPhoneNumber`,
    );
    const contributionUniversalIdentifier =
      afterCreate.contributions[0].universalIdentifier;
    const personId = faker.string.uuid();
    const created = await createOneOperation({
      objectMetadataSingularName: 'person',
      input: {
        id: personId,
        phones: usPhone('4155550205'),
        [logicalFieldName]: {
          ...usPhone('4155550201'),
          additionalPhones: [additionalUsPhone('4155550202')],
        },
      },
      gqlFields: 'id',
    });

    expect(created.errors).toBeUndefined();
    createdPersonIds.push(personId);

    await expectPhoneSearchIds('+14155550201', [personId]);
    await expectPhoneSearchIds('+14155550202', [personId]);
    await expectPhoneSearchIds('+14155550205', [personId]);

    await updateOneFieldMetadata({
      input: { idToUpdate: fieldId, updatePayload: { isActive: false } },
      expectToFail: false,
    });
    const afterDeactivate = await getPhoneMetadataState(fieldId);

    expect(afterDeactivate.vector).toBeDefined();
    expect(afterDeactivate.indexes).toHaveLength(1);
    expect(afterDeactivate.contributions).toHaveLength(0);
    expect(afterDeactivate.column.generation_expression).not.toContain(
      `${logicalFieldName}PrimaryPhoneNumber`,
    );
    await expectPhoneSearchIds('+14155550201', []);
    await expectPhoneSearchIds('+14155550202', []);
    await expectPhoneSearchIds('+14155550205', [personId]);

    await updateOneFieldMetadata({
      input: { idToUpdate: fieldId, updatePayload: { isActive: true } },
      expectToFail: false,
    });
    const afterReactivate = await getPhoneMetadataState(fieldId);

    expect(afterReactivate.contributions).toHaveLength(1);
    expect(afterReactivate.contributions[0].universalIdentifier).toBe(
      contributionUniversalIdentifier,
    );
    await expectPhoneSearchIds('+14155550201', [personId]);
    await expectPhoneSearchIds('+14155550202', [personId]);

    await updateOneFieldMetadata({
      input: { idToUpdate: fieldId, updatePayload: { name: renamedFieldName } },
      expectToFail: false,
    });
    const afterRename = await getPhoneMetadataState(fieldId);

    expect(afterRename.vector).toBeDefined();
    expect(afterRename.indexes).toHaveLength(1);
    expect(afterRename.contributions).toHaveLength(1);
    expect(afterRename.contributions[0].universalIdentifier).toBe(
      contributionUniversalIdentifier,
    );
    expect(afterRename.column.generation_expression).toContain(
      `${renamedFieldName}PrimaryPhoneNumber`,
    );
    expect(afterRename.column.generation_expression).not.toContain(
      `${logicalFieldName}PrimaryPhoneNumber`,
    );
    await expectPhoneSearchIds('+14155550201', [personId]);
    await expectPhoneSearchIds('+14155550202', [personId]);

    await updateOneFieldMetadata({
      input: { idToUpdate: fieldId, updatePayload: { isActive: false } },
      expectToFail: false,
    });
    await deleteOneFieldMetadata({
      input: { idToDelete: fieldId },
      expectToFail: false,
    });
    createdFieldIds.splice(createdFieldIds.indexOf(fieldId), 1);
    const afterDelete = await getPhoneMetadataState(fieldId);

    expect(afterDelete.vector).toBeDefined();
    expect(afterDelete.indexes).toHaveLength(1);
    expect(afterDelete.contributions).toHaveLength(0);
    const physicalColumns = await global.testDataSource.query(
      `SELECT column_name FROM information_schema.columns
       WHERE table_schema = $1 AND table_name = 'person'
         AND column_name LIKE $2`,
      [TEST_WORKSPACE_SCHEMA, `${renamedFieldName}%`],
    );
    expect(physicalColumns).toHaveLength(0);
    await expectPhoneSearchIds('+14155550201', []);
    await expectPhoneSearchIds('+14155550202', []);

    const textField = await createOneFieldMetadata({
      input: {
        name: logicalFieldName,
        label: logicalFieldName,
        type: FieldMetadataType.TEXT,
        objectMetadataId: personObjectMetadataId,
        isLabelSyncedWithName: false,
      },
      gqlFields: 'id',
      expectToFail: false,
    });
    fieldId = textField.data.createOneField.id;
    createdFieldIds.push(fieldId);
    const textState = await getPhoneMetadataState(fieldId);

    expect(textState.contributions).toHaveLength(0);
    expect(textState.column.generation_expression).not.toContain(
      logicalFieldName,
    );
    const textPersonId = faker.string.uuid();
    const textPerson = await createOneOperation({
      objectMetadataSingularName: 'person',
      input: { id: textPersonId, [logicalFieldName]: '4155550203' },
      gqlFields: 'id',
    });
    expect(textPerson.errors).toBeUndefined();
    createdPersonIds.push(textPersonId);
    await expectPhoneSearchIds('+14155550203', []);

    await updateOneFieldMetadata({
      input: { idToUpdate: fieldId, updatePayload: { isActive: false } },
      expectToFail: false,
    });
    await deleteOneFieldMetadata({
      input: { idToDelete: fieldId },
      expectToFail: false,
    });
    createdFieldIds.splice(createdFieldIds.indexOf(fieldId), 1);

    fieldId = await createPhonesField(logicalFieldName);
    const recreatedPhoneState = await getPhoneMetadataState(fieldId);

    expect(recreatedPhoneState.contributions).toHaveLength(1);
    expect(recreatedPhoneState.column.generation_expression).toContain(
      `${logicalFieldName}PrimaryPhoneNumber`,
    );
    const replacementPersonId = faker.string.uuid();
    const replacementPerson = await createOneOperation({
      objectMetadataSingularName: 'person',
      input: {
        id: replacementPersonId,
        [logicalFieldName]: usPhone('4155550204'),
      },
      gqlFields: 'id',
    });
    expect(replacementPerson.errors).toBeUndefined();
    createdPersonIds.push(replacementPersonId);
    await expectPhoneSearchIds('+14155550204', [replacementPersonId]);
  });
});
