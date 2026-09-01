import { randomUUID } from 'crypto';

import request from 'supertest';
import { createCustomRoleWithObjectPermissions } from 'test/integration/graphql/utils/create-custom-role-with-object-permissions.util';
import { createOneOperation } from 'test/integration/graphql/utils/create-one-operation.util';
import { deleteRole } from 'test/integration/graphql/utils/delete-one-role.util';
import { searchPeopleByPhone } from 'test/integration/graphql/utils/search-people-by-phone.util';
import { updateWorkspaceMemberRole } from 'test/integration/graphql/utils/update-workspace-member-role.util';
import { upsertFieldPermissions } from 'test/integration/graphql/utils/upsert-field-permissions.util';
import { deleteRecordsByIds } from 'test/integration/utils/delete-records-by-ids';
import { createOneFieldMetadata } from 'test/integration/metadata/suites/field-metadata/utils/create-one-field-metadata.util';
import { deleteOneFieldMetadata } from 'test/integration/metadata/suites/field-metadata/utils/delete-one-field-metadata.util';
import { updateOneFieldMetadata } from 'test/integration/metadata/suites/field-metadata/utils/update-one-field-metadata.util';
import { makeMetadataAPIRequest } from 'test/integration/metadata/suites/utils/make-metadata-api-request.util';
import gql from 'graphql-tag';
import { FieldMetadataType } from 'twenty-shared/types';

import { WORKSPACE_MEMBER_DATA_SEED_IDS } from 'src/engine/workspace-manager/dev-seeder/data/constants/workspace-member-data-seeds.constant';

jest.setTimeout(120000);

const suffix = `${Date.now()}${Math.floor(Math.random() * 10000)}`;
const readableFieldName = `phoneSearchReadable${suffix}`;
const restrictedFieldName = `phoneSearchRestricted${suffix}`;
const client = request(`http://localhost:${APP_PORT}`);

const phoneValue = (number: string) => ({
  primaryPhoneNumber: number,
  primaryPhoneCallingCode: '+1',
  primaryPhoneCountryCode: 'US',
});

describe('searchPeopleByPhone field permissions', () => {
  let personObjectMetadataId: string;
  let readableFieldId: string;
  let restrictedFieldId: string;
  let customRoleId: string;
  let originalMemberRoleId: string;
  const createdPersonIds: string[] = [];

  beforeAll(async () => {
    const rolesResponse = await client
      .post('/metadata')
      .set('Authorization', `Bearer ${APPLE_JANE_ADMIN_ACCESS_TOKEN}`)
      .send({ query: '{ getRoles { id label } }' });

    originalMemberRoleId = rolesResponse.body.data.getRoles.find(
      (role: { label: string }) => role.label === 'Member',
    ).id;

    const objectResponse = await makeMetadataAPIRequest({
      query: gql`
        query PersonMetadataForPhonePermissionTest {
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
    personObjectMetadataId = objectResponse.body.data.objects.edges.find(
      (edge: { node: { nameSingular: string } }) =>
        edge.node.nameSingular === 'person',
    ).node.id;

    const createField = async (name: string) => {
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

      return response.data.createOneField.id;
    };

    readableFieldId = await createField(readableFieldName);
    restrictedFieldId = await createField(restrictedFieldName);

    const { roleId } = await createCustomRoleWithObjectPermissions({
      label: `Phone Search Permission ${suffix}`,
      canReadPerson: true,
      hasAllObjectRecordsReadPermission: true,
    });
    customRoleId = roleId;
    await upsertFieldPermissions({
      roleId: customRoleId,
      fieldPermissions: [
        {
          objectMetadataId: personObjectMetadataId,
          fieldMetadataId: restrictedFieldId,
          canReadFieldValue: false,
        },
      ],
    });
    await updateWorkspaceMemberRole({
      client,
      roleId: customRoleId,
      workspaceMemberId: WORKSPACE_MEMBER_DATA_SEED_IDS.JONY,
    });

    for (const data of [
      { [readableFieldName]: phoneValue('4155551400') },
      { [restrictedFieldName]: phoneValue('4155551401') },
      {
        [readableFieldName]: phoneValue('4155551402'),
        [restrictedFieldName]: phoneValue('4155551402'),
      },
    ]) {
      const id = randomUUID();
      const response = await createOneOperation({
        objectMetadataSingularName: 'person',
        input: { id, ...data },
        gqlFields: 'id',
      });

      expect(response.errors).toBeUndefined();
      createdPersonIds.push(id);
    }
  });

  afterAll(async () => {
    if (originalMemberRoleId) {
      await updateWorkspaceMemberRole({
        client,
        roleId: originalMemberRoleId,
        workspaceMemberId: WORKSPACE_MEMBER_DATA_SEED_IDS.JONY,
      });
    }
    if (customRoleId) await deleteRole(client, customRoleId);
    await deleteRecordsByIds('person', createdPersonIds);

    for (const fieldId of [restrictedFieldId, readableFieldId]) {
      if (!fieldId) continue;
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
        // Guard cleanup after partial metadata setup.
      }
    }
  });

  it.each([
    ['returns a match from a readable phone field', '+14155551400', [0]],
    [
      'does not reveal a match from a restricted-only phone field',
      '+14155551401',
      [],
    ],
    [
      'returns one match when the value is in readable and restricted fields',
      '+14155551402',
      [2],
    ],
  ])('%s', async (_name, phoneNumber, matchingIndexes) => {
    const response = await searchPeopleByPhone({
      phoneNumber,
      limit: 10,
      accessToken: APPLE_JONY_MEMBER_ACCESS_TOKEN,
    });

    expect(response.errors).toBeUndefined();
    expect(
      response.data?.searchPeopleByPhone.edges.map(({ node }) => node.recordId),
    ).toEqual(matchingIndexes.map((index) => createdPersonIds[index]));
  });
});
