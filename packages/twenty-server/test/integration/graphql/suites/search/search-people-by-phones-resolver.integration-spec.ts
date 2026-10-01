import { randomUUID } from 'crypto';

import { createOneOperation } from 'test/integration/graphql/utils/create-one-operation.util';
import {
  type BulkPhoneSearchLookupResult,
  searchPeopleByPhones,
} from 'test/integration/graphql/utils/search-people-by-phones.util';
import { searchPeopleByPhone } from 'test/integration/graphql/utils/search-people-by-phone.util';
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

jest.setTimeout(120000);

const suffix = `${Date.now()}${Math.floor(Math.random() * 10000)}`;
const customPhoneFieldName = `bulkPhoneSearchPerson${suffix}`;
const companyPhoneFieldName = `bulkPhoneSearchCompany${suffix}`;
const lineNumberBase = 2000 + Math.floor(Math.random() * 5000);
const wait = (milliseconds: number) =>
  new Promise((resolve) => setTimeout(resolve, milliseconds));
const nationalPhone = (offset: number) =>
  `415555${String(lineNumberBase + offset).padStart(4, '0')}`;
const e164Phone = (offset: number) => `+1${nationalPhone(offset)}`;
const primaryPhone = (offset: number) => ({
  primaryPhoneNumber: nationalPhone(offset),
  primaryPhoneCallingCode: '+1',
  primaryPhoneCountryCode: 'US',
});
const additionalPhone = (offset: number) => ({
  number: nationalPhone(offset),
  callingCode: '+1',
  countryCode: 'US',
});

const expectResults = (
  actual: BulkPhoneSearchLookupResult[] | undefined,
  expected: Array<Partial<BulkPhoneSearchLookupResult>>,
) => {
  expect(actual).toHaveLength(expected.length);
  expected.forEach((result, index) =>
    expect(actual?.[index]).toMatchObject(result),
  );
};

describe('searchPeopleByPhones bulk resolver', () => {
  let personObjectMetadataId: string;
  let companyObjectMetadataId: string;
  let customPhoneFieldId: string;
  let companyPhoneFieldId: string;
  const createdPersonIds: string[] = [];
  const createdCompanyIds: string[] = [];
  const personIds: Record<string, string> = {};

  const createField = async (name: string, objectMetadataId: string) => {
    for (let attempt = 0; attempt < 600; attempt++) {
      const response = await createOneFieldMetadata({
        input: {
          name,
          label: name,
          type: FieldMetadataType.PHONES,
          objectMetadataId,
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
      ) {
        throw new Error(
          `Field creation failed: ${JSON.stringify(response.errors)}`,
        );
      }
      await wait(100);
    }

    throw new Error('Timed out waiting for phone-search metadata gate');
  };

  const createPerson = async (key: string, data: Record<string, unknown>) => {
    const id = randomUUID();
    const response = await createOneOperation({
      objectMetadataSingularName: 'person',
      input: { id, ...data },
      gqlFields: 'id',
    });

    expect(response.errors).toBeUndefined();
    createdPersonIds.push(id);
    personIds[key] = id;
  };

  beforeAll(async () => {
    await getAppProviderByClassName<InitializePersonPhoneSearchLookupCommand>(
      InitializePersonPhoneSearchLookupCommand.name,
    ).runOnWorkspace({
      workspaceId: SEED_APPLE_WORKSPACE_ID,
      options: {},
      index: 0,
      total: 1,
    });

    const objectsResponse = await makeMetadataAPIRequest({
      query: gql`
        query BulkPhoneSearchTestObjects {
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
    const objects = objectsResponse.body.data.objects.edges.map(
      (edge: { node: { id: string; nameSingular: string } }) => edge.node,
    );

    personObjectMetadataId = objects.find(
      (object: { nameSingular: string }) => object.nameSingular === 'person',
    ).id;
    companyObjectMetadataId = objects.find(
      (object: { nameSingular: string }) => object.nameSingular === 'company',
    ).id;
    customPhoneFieldId = await createField(
      customPhoneFieldName,
      personObjectMetadataId,
    );
    companyPhoneFieldId = await createField(
      companyPhoneFieldName,
      companyObjectMetadataId,
    );

    await createPerson('sharedOne', { phones: primaryPhone(0) });
    await createPerson('sharedTwo', {
      [customPhoneFieldName]: primaryPhone(0),
    });
    await createPerson('twoNumbers', {
      phones: {
        ...primaryPhone(1),
        additionalPhones: [additionalPhone(2)],
      },
    });
    await createPerson('pairedOne', { phones: primaryPhone(3) });
    await createPerson('pairedTwo', {
      [customPhoneFieldName]: {
        additionalPhones: [additionalPhone(4)],
      },
    });
    await createPerson('deduplicated', {
      phones: {
        ...primaryPhone(5),
        additionalPhones: [additionalPhone(5)],
      },
      [customPhoneFieldName]: primaryPhone(5),
    });
    await createPerson('textControl', { jobTitle: e164Phone(6) });

    for (const key of ['limitedOne', 'limitedTwo', 'limitedThree']) {
      await createPerson(key, { phones: primaryPhone(8) });
    }

    const companyId = randomUUID();
    const companyResponse = await createOneOperation({
      objectMetadataSingularName: 'company',
      input: {
        id: companyId,
        name: `Bulk phone isolation ${suffix}`,
        [companyPhoneFieldName]: primaryPhone(7),
      },
      gqlFields: 'id',
    });

    expect(companyResponse.errors).toBeUndefined();
    createdCompanyIds.push(companyId);

    for (let attempt = 0; attempt < 600; attempt++) {
      const response = await searchPeopleByPhone({
        phoneNumber: e164Phone(0),
        limit: 10,
      });
      const ids = response.data?.searchPeopleByPhone.edges.map(
        ({ node }) => node.recordId,
      );

      if (
        ids?.includes(personIds.sharedOne) &&
        ids.includes(personIds.sharedTwo)
      )
        break;
      if (attempt === 599)
        throw new Error('Timed out waiting for bulk phone-search fixtures');
      await wait(100);
    }
  });

  afterAll(async () => {
    await deleteRecordsByIds('person', createdPersonIds);
    await deleteRecordsByIds('company', createdCompanyIds);

    for (const fieldId of [companyPhoneFieldId, customPhoneFieldId]) {
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

  it('returns both people when one number belongs to two different people', async () => {
    const response = await searchPeopleByPhones({
      lookups: [{ clientReference: 'shared', phoneNumber: e164Phone(0) }],
    });

    expect(response.errors).toBeUndefined();
    expectResults(response.data?.searchPeopleByPhones.results, [
      {
        clientReference: 'shared',
        status: 'FOUND',
        matches: [personIds.sharedOne, personIds.sharedTwo]
          .sort()
          .map((recordId) => ({ recordId })),
        hasMore: false,
        error: null,
      },
    ]);
  });

  it('maps two different numbers on one person to two independent results', async () => {
    const response = await searchPeopleByPhones({
      lookups: [
        { clientReference: 'primary', phoneNumber: e164Phone(1) },
        { clientReference: 'additional', phoneNumber: e164Phone(2) },
      ],
    });

    expect(response.errors).toBeUndefined();
    expectResults(response.data?.searchPeopleByPhones.results, [
      {
        clientReference: 'primary',
        matches: [{ recordId: personIds.twoNumbers }],
      },
      {
        clientReference: 'additional',
        matches: [{ recordId: personIds.twoNumbers }],
      },
    ]);
  });

  it('maps two requested numbers to their respective people in one batch', async () => {
    const response = await searchPeopleByPhones({
      lookups: [
        { clientReference: 'first-person', phoneNumber: e164Phone(3) },
        { clientReference: 'second-person', phoneNumber: e164Phone(4) },
      ],
    });

    expect(response.errors).toBeUndefined();
    expectResults(response.data?.searchPeopleByPhones.results, [
      { matches: [{ recordId: personIds.pairedOne }] },
      { matches: [{ recordId: personIds.pairedTwo }] },
    ]);
  });

  it('deduplicates one person matched through primary, additional, and custom fields', async () => {
    const response = await searchPeopleByPhones({
      lookups: [{ clientReference: 'dedupe', phoneNumber: e164Phone(5) }],
    });

    expect(response.errors).toBeUndefined();
    expect(response.data?.searchPeopleByPhones.results[0]?.matches).toEqual([
      { recordId: personIds.deduplicated },
    ]);
  });

  it('does not match non-phone Person fields, Company phones, or missing values', async () => {
    const response = await searchPeopleByPhones({
      lookups: [
        { clientReference: 'text', phoneNumber: e164Phone(6) },
        { clientReference: 'company', phoneNumber: e164Phone(7) },
        { clientReference: 'missing', phoneNumber: e164Phone(9) },
      ],
    });

    expect(response.errors).toBeUndefined();
    expectResults(response.data?.searchPeopleByPhones.results, [
      { clientReference: 'text', status: 'NOT_FOUND', matches: [] },
      { clientReference: 'company', status: 'NOT_FOUND', matches: [] },
      { clientReference: 'missing', status: 'NOT_FOUND', matches: [] },
    ]);
  });

  it('returns found, missing, and invalid outcomes independently in input order', async () => {
    const response = await searchPeopleByPhones({
      lookups: [
        { clientReference: 'found', phoneNumber: e164Phone(3) },
        { clientReference: 'invalid', phoneNumber: '415-555-0100' },
        { clientReference: 'missing', phoneNumber: e164Phone(9) },
      ],
    });

    expect(response.errors).toBeUndefined();
    expectResults(response.data?.searchPeopleByPhones.results, [
      { clientReference: 'found', status: 'FOUND' },
      {
        clientReference: 'invalid',
        phoneNumber: '415-555-0100',
        status: 'INVALID',
        matches: [],
        hasMore: false,
        error: {
          code: 'INVALID_PHONE_NUMBER',
          message: expect.any(String),
        },
      },
      { clientReference: 'missing', status: 'NOT_FOUND' },
    ]);
  });

  it('preserves duplicate phone inputs as separately correlated results', async () => {
    const response = await searchPeopleByPhones({
      lookups: [
        { clientReference: 'duplicate-a', phoneNumber: e164Phone(3) },
        { clientReference: 'between', phoneNumber: e164Phone(9) },
        { clientReference: 'duplicate-b', phoneNumber: e164Phone(3) },
      ],
    });

    expect(response.errors).toBeUndefined();
    expect(
      response.data?.searchPeopleByPhones.results.map((result) => ({
        clientReference: result.clientReference,
        matches: result.matches,
      })),
    ).toEqual([
      {
        clientReference: 'duplicate-a',
        matches: [{ recordId: personIds.pairedOne }],
      },
      { clientReference: 'between', matches: [] },
      {
        clientReference: 'duplicate-b',
        matches: [{ recordId: personIds.pairedOne }],
      },
    ]);
  });

  it('accepts 100 inputs', async () => {
    const response = await searchPeopleByPhones({
      lookups: Array.from({ length: 100 }, (_, index) => ({
        clientReference: `accepted-${index}`,
        phoneNumber: e164Phone(3),
      })),
    });

    expect(response.errors).toBeUndefined();
    expect(response.data?.searchPeopleByPhones.results).toHaveLength(100);
  });

  it('rejects 101 inputs and duplicate client references as structural errors', async () => {
    const oversized = await searchPeopleByPhones({
      lookups: Array.from({ length: 101 }, (_, index) => ({
        clientReference: `rejected-${index}`,
        phoneNumber: e164Phone(3),
      })),
    });
    const duplicateReferences = await searchPeopleByPhones({
      lookups: [
        { clientReference: 'same-reference', phoneNumber: e164Phone(3) },
        { clientReference: 'same-reference', phoneNumber: e164Phone(4) },
      ],
    });

    expect(oversized.errors?.[0]?.message).toContain('100');
    expect(duplicateReferences.errors?.[0]?.message).toContain(
      'clientReference',
    );
  });

  it('rejects an empty batch, blank client references, and out-of-range match limits', async () => {
    const empty = await searchPeopleByPhones({ lookups: [] });
    const blankReference = await searchPeopleByPhones({
      lookups: [{ clientReference: '   ', phoneNumber: e164Phone(3) }],
    });
    const zeroLimit = await searchPeopleByPhones({
      lookups: [{ clientReference: 'zero-limit', phoneNumber: e164Phone(3) }],
      matchLimitPerPhone: 0,
    });
    const oversizedLimit = await searchPeopleByPhones({
      lookups: [
        { clientReference: 'oversized-limit', phoneNumber: e164Phone(3) },
      ],
      matchLimitPerPhone: 101,
    });

    expect(empty.errors).toBeDefined();
    expect(blankReference.errors?.[0]?.message).toContain('clientReference');
    expect(zeroLimit.errors).toBeDefined();
    expect(oversizedLimit.errors?.[0]?.message).toContain('100');
  });

  it('caps each number independently and reports additional matches', async () => {
    const response = await searchPeopleByPhones({
      lookups: [
        { clientReference: 'limited', phoneNumber: e164Phone(8) },
        { clientReference: 'unlimited-control', phoneNumber: e164Phone(3) },
      ],
      matchLimitPerPhone: 2,
    });

    expect(response.errors).toBeUndefined();
    expectResults(response.data?.searchPeopleByPhones.results, [
      {
        clientReference: 'limited',
        matches: [
          personIds.limitedOne,
          personIds.limitedTwo,
          personIds.limitedThree,
        ]
          .sort()
          .slice(0, 2)
          .map((recordId) => ({ recordId })),
        hasMore: true,
      },
      {
        clientReference: 'unlimited-control',
        matches: [{ recordId: personIds.pairedOne }],
        hasMore: false,
      },
    ]);
  });
});
