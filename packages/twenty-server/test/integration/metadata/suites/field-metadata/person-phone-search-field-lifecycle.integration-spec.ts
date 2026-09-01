import { faker } from '@faker-js/faker';
import { searchPeopleByPhone } from 'test/integration/graphql/utils/search-people-by-phone.util';
import { createOneOperation } from 'test/integration/graphql/utils/create-one-operation.util';
import { deleteRecordsByIds } from 'test/integration/utils/delete-records-by-ids';
import { createOneFieldMetadata } from 'test/integration/metadata/suites/field-metadata/utils/create-one-field-metadata.util';
import { deleteOneFieldMetadata } from 'test/integration/metadata/suites/field-metadata/utils/delete-one-field-metadata.util';
import { updateOneFieldMetadata } from 'test/integration/metadata/suites/field-metadata/utils/update-one-field-metadata.util';
import { makeMetadataAPIRequest } from 'test/integration/metadata/suites/utils/make-metadata-api-request.util';
import gql from 'graphql-tag';
import { FieldMetadataType } from 'twenty-shared/types';

jest.setTimeout(120000);

const runSuffix = `${Date.now()}${Math.floor(Math.random() * 10000)}`;
const logicalFieldName = `phoneSearchLifecycle${runSuffix}`;
const renamedFieldName = `renamedPhoneSearchLifecycle${runSuffix}`;
const createdPersonIds: string[] = [];
const createdFieldIds: string[] = [];

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
    const personId = faker.string.uuid();
    const created = await createOneOperation({
      objectMetadataSingularName: 'person',
      input: {
        id: personId,
        [logicalFieldName]: {
          ...usPhone('4155550201'),
          additionalPhones: [additionalUsPhone('4155550202')],
        },
      },
      gqlFields: 'id',
    });

    expect(created.errors).toBeUndefined();
    createdPersonIds.push(personId);

    // The first assertion is intentionally red until searchPeopleByPhone exists.
    await expectPhoneSearchIds('+14155550201', [personId]);
    await expectPhoneSearchIds('+14155550202', [personId]);

    await updateOneFieldMetadata({
      input: { idToUpdate: fieldId, updatePayload: { isActive: false } },
      expectToFail: false,
    });
    await expectPhoneSearchIds('+14155550201', []);
    await expectPhoneSearchIds('+14155550202', []);

    await updateOneFieldMetadata({
      input: { idToUpdate: fieldId, updatePayload: { isActive: true } },
      expectToFail: false,
    });
    await expectPhoneSearchIds('+14155550201', [personId]);
    await expectPhoneSearchIds('+14155550202', [personId]);

    await updateOneFieldMetadata({
      input: { idToUpdate: fieldId, updatePayload: { name: renamedFieldName } },
      expectToFail: false,
    });
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
