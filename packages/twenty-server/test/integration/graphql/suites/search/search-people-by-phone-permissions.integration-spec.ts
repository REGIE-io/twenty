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
import { getAppProviderByClassName } from 'test/integration/utils/get-app-provider-by-class-name.util';
import gql from 'graphql-tag';
import { FieldMetadataType } from 'twenty-shared/types';

import { InitializePersonPhoneSearchLookupCommand } from 'src/database/commands/upgrade-version-command/2-32/2-32-workspace-command-1786800001000-initialize-person-phone-search-lookup.command';
import { SEED_APPLE_WORKSPACE_ID } from 'src/engine/workspace-manager/dev-seeder/core/constants/seeder-workspaces.constant';
import { WORKSPACE_MEMBER_DATA_SEED_IDS } from 'src/engine/workspace-manager/dev-seeder/data/constants/workspace-member-data-seeds.constant';

jest.setTimeout(120000);

const suffix = `${Date.now()}${Math.floor(Math.random() * 10000)}`;
const readableFieldName = `phoneSearchReadable${suffix}`;
const restrictedFieldName = `phoneSearchRestricted${suffix}`;
const client = request(`http://localhost:${APP_PORT}`);
const wait = (milliseconds: number) =>
  new Promise((resolve) => setTimeout(resolve, milliseconds));

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
    await getAppProviderByClassName<InitializePersonPhoneSearchLookupCommand>(
      InitializePersonPhoneSearchLookupCommand.name,
    ).runOnWorkspace({
      workspaceId: SEED_APPLE_WORKSPACE_ID,
      options: {},
      index: 0,
      total: 1,
    });

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
      for (let attempt = 0; attempt < 600; attempt++) {
        const response = await createOneFieldMetadata({
          input: {
            name,
            label: name,
            type: FieldMetadataType.PHONES,
            objectMetadataId: personObjectMetadataId,
            isLabelSyncedWithName: false,
          },
          gqlFields: 'id',
          expectToFail: undefined,
        });
        const id = response.data?.createOneField?.id;

        if (id) return id;
        const serializedErrors = JSON.stringify(response.errors);

        if (
          !serializedErrors.includes('PHONE_SEARCH_METADATA_BUSY') &&
          !serializedErrors.includes('"code":"503"')
        )
          throw new Error(
            `Field creation failed: ${JSON.stringify(response.errors)}`,
          );
        await wait(100);
      }

      throw new Error('Timed out waiting for phone-search metadata gate');
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

    for (let attempt = 0; attempt < 600; attempt++) {
      const response = await searchPeopleByPhone({
        phoneNumber: '+14155551400',
        limit: 10,
      });
      const serializedErrors = JSON.stringify(response.errors);

      if (response.errors && !serializedErrors.includes('"code":"503"'))
        throw new Error(`Phone search failed: ${serializedErrors}`);

      if (
        response.data?.searchPeopleByPhone.edges.some(
          ({ node }) => node.recordId === createdPersonIds[0],
        )
      )
        break;
      if (attempt === 599)
        throw new Error(
          'Timed out waiting for permission-test phone projection',
        );
      await wait(100);
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
