import { faker } from '@faker-js/faker';
import { searchPeopleByPhone } from 'test/integration/graphql/utils/search-people-by-phone.util';
import { updateOneOperationFactory } from 'test/integration/graphql/utils/update-one-operation-factory.util';
import { makeGraphqlAPIRequest } from 'test/integration/graphql/utils/make-graphql-api-request.util';
import { search } from 'test/integration/graphql/utils/search.util';
import { createOneOperation } from 'test/integration/graphql/utils/create-one-operation.util';
import { deleteRecordsByIds } from 'test/integration/utils/delete-records-by-ids';
import { createOneFieldMetadata } from 'test/integration/metadata/suites/field-metadata/utils/create-one-field-metadata.util';
import { deleteOneFieldMetadata } from 'test/integration/metadata/suites/field-metadata/utils/delete-one-field-metadata.util';
import { updateOneFieldMetadata } from 'test/integration/metadata/suites/field-metadata/utils/update-one-field-metadata.util';
import { makeMetadataAPIRequest } from 'test/integration/metadata/suites/utils/make-metadata-api-request.util';
import gql from 'graphql-tag';
import { FieldMetadataType } from 'twenty-shared/types';

type PhoneValue = {
  primaryPhoneNumber?: string;
  primaryPhoneCallingCode?: string;
  primaryPhoneCountryCode?: string;
  additionalPhones?: Array<{
    number: string;
    callingCode: string;
    countryCode: string;
  }>;
};

const runSuffix = `${Date.now()}${Math.floor(Math.random() * 10000)}`;
const customPhoneOne = `phoneSearchAlternateOne${runSuffix}`;
const customPhoneTwo = `phoneSearchAlternateTwo${runSuffix}`;
const companyPhone = `phoneSearchCompany${runSuffix}`;
const createdPersonIds: string[] = [];
const createdCompanyIds: string[] = [];
const createdFieldIds: string[] = [];

const usPhone = (number: string): PhoneValue => ({
  primaryPhoneNumber: number,
  primaryPhoneCallingCode: '+1',
  primaryPhoneCountryCode: 'US',
});

const additionalUsPhone = (number: string) => ({
  number,
  callingCode: '+1',
  countryCode: 'US',
});

const toE164 = (number: string) => `+1${number}`;
const wait = (milliseconds: number) =>
  new Promise((resolve) => setTimeout(resolve, milliseconds));

const expectSearchIds = async (
  phoneNumber: string,
  expectedIds: string[],
  countryCode?: string,
) => {
  const response = await searchPeopleByPhone({
    phoneNumber,
    countryCode,
    limit: 50,
  });

  expect(response.errors).toBeUndefined();
  expect(response.data).toBeDefined();
  expect(
    response.data?.searchPeopleByPhone.edges.map(({ node }) => node.recordId),
  ).toEqual(expectedIds);
};

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

    if (id) {
      createdFieldIds.push(id);
      return id;
    }
    if (!JSON.stringify(response.errors).includes('PHONE_SEARCH_METADATA_BUSY'))
      throw new Error(
        `Field creation failed: ${JSON.stringify(response.errors)}`,
      );
    await wait(100);
  }

  throw new Error('Timed out waiting for phone-search metadata gate');
};

const waitForPhoneMatch = async (phoneNumber: string, recordId: string) => {
  for (let attempt = 0; attempt < 600; attempt++) {
    const response = await searchPeopleByPhone({ phoneNumber, limit: 10 });
    const ids = response.data?.searchPeopleByPhone.edges.map(
      ({ node }) => node.recordId,
    );

    if (ids?.includes(recordId)) return;
    await wait(100);
  }

  throw new Error(`Timed out waiting for phone projection of ${recordId}`);
};

describe('SearchPeopleByPhone resolver', () => {
  let personObjectMetadataId: string;
  let companyObjectMetadataId: string;
  const personByCase: Record<string, string> = {};

  beforeAll(async () => {
    const objectsResponse = await makeMetadataAPIRequest({
      query: gql`
        query PhoneSearchTestObjects {
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

    expect(objectsResponse.body.errors).toBeUndefined();
    const objects = objectsResponse.body.data.objects.edges.map(
      (edge: { node: { id: string; nameSingular: string } }) => edge.node,
    );

    personObjectMetadataId = objects.find(
      (object: { nameSingular: string }) => object.nameSingular === 'person',
    )?.id;
    companyObjectMetadataId = objects.find(
      (object: { nameSingular: string }) => object.nameSingular === 'company',
    )?.id;

    expect(personObjectMetadataId).toBeDefined();
    expect(companyObjectMetadataId).toBeDefined();

    await createField(customPhoneOne, personObjectMetadataId);
    await createField(customPhoneTwo, personObjectMetadataId);
    await createField(companyPhone, companyObjectMetadataId);

    const people: Array<{ key: string; data: Record<string, unknown> }> = [
      { key: 'standardPrimary', data: { phones: usPhone('4155550101') } },
      {
        key: 'standardAdditional',
        data: {
          phones: { additionalPhones: [additionalUsPhone('4155550102')] },
        },
      },
      {
        key: 'standardBoth',
        data: {
          phones: {
            ...usPhone('4155550103'),
            additionalPhones: [additionalUsPhone('4155550104')],
          },
        },
      },
      {
        key: 'standardDuplicate',
        data: {
          phones: {
            ...usPhone('4155550105'),
            additionalPhones: [additionalUsPhone('4155550105')],
          },
        },
      },
      {
        key: 'customOnePrimary',
        data: { [customPhoneOne]: usPhone('4155550106') },
      },
      {
        key: 'customOneAdditional',
        data: {
          [customPhoneOne]: {
            additionalPhones: [additionalUsPhone('4155550107')],
          },
        },
      },
      {
        key: 'customTwoPrimary',
        data: { [customPhoneTwo]: usPhone('4155550108') },
      },
      {
        key: 'customTwoAdditional',
        data: {
          [customPhoneTwo]: {
            additionalPhones: [additionalUsPhone('4155550109')],
          },
        },
      },
      {
        key: 'customBothDifferent',
        data: {
          [customPhoneOne]: usPhone('4155550110'),
          [customPhoneTwo]: usPhone('4155550111'),
        },
      },
      {
        key: 'customDuplicate',
        data: {
          [customPhoneOne]: usPhone('4155550112'),
          [customPhoneTwo]: usPhone('4155550112'),
        },
      },
      {
        key: 'allPhoneFields',
        data: {
          phones: usPhone('4155550113'),
          [customPhoneOne]: usPhone('4155550114'),
          [customPhoneTwo]: usPhone('4155550115'),
        },
      },
      {
        key: 'nonPhoneOnly',
        data: {
          jobTitle: '4155550116',
          name: { firstName: `GenericPhoneControl${runSuffix}` },
        },
      },
      { key: 'paginationOne', data: { phones: usPhone('4155550117') } },
      {
        key: 'paginationTwo',
        data: { [customPhoneTwo]: usPhone('4155550117') },
      },
    ];

    for (const { key, data } of people) {
      const id = faker.string.uuid();
      const response = await createOneOperation({
        objectMetadataSingularName: 'person',
        input: { id, ...data },
        gqlFields: 'id',
      });

      expect(response.errors).toBeUndefined();
      createdPersonIds.push(id);
      personByCase[key] = id;
    }

    for (const phones of [
      { [companyPhone]: usPhone('4155550118') },
      {
        [companyPhone]: { additionalPhones: [additionalUsPhone('4155550119')] },
      },
      { [companyPhone]: usPhone('4155550101') },
    ]) {
      const id = faker.string.uuid();
      const response = await createOneOperation({
        objectMetadataSingularName: 'company',
        input: { id, name: `Phone isolation ${id}`, ...phones },
        gqlFields: 'id',
      });

      expect(response.errors).toBeUndefined();
      createdCompanyIds.push(id);
    }

    await waitForPhoneMatch(
      toE164('4155550106'),
      personByCase.customOnePrimary,
    );
  }, 120000);

  afterAll(async () => {
    await deleteRecordsByIds('person', createdPersonIds);
    await deleteRecordsByIds('company', createdCompanyIds);

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
        // A failed setup can leave no metadata row to clean up.
      }
    }
  }, 120000);

  it.each([
    ['standard primary', '4155550101', 'standardPrimary'],
    ['standard additional', '4155550102', 'standardAdditional'],
    [
      'standard primary from a record with both values',
      '4155550103',
      'standardBoth',
    ],
    [
      'standard additional from a record with both values',
      '4155550104',
      'standardBoth',
    ],
    ['custom field one primary', '4155550106', 'customOnePrimary'],
    ['custom field one additional', '4155550107', 'customOneAdditional'],
    ['custom field two primary', '4155550108', 'customTwoPrimary'],
    ['custom field two additional', '4155550109', 'customTwoAdditional'],
    [
      'the first custom field on a record with two custom values',
      '4155550110',
      'customBothDifferent',
    ],
    [
      'the second custom field on a record with two custom values',
      '4155550111',
      'customBothDifferent',
    ],
    [
      'the standard field on a record with every phone field',
      '4155550113',
      'allPhoneFields',
    ],
    [
      'custom field one on a record with every phone field',
      '4155550114',
      'allPhoneFields',
    ],
    [
      'custom field two on a record with every phone field',
      '4155550115',
      'allPhoneFields',
    ],
  ])('finds %s only', async (_title, number, personKey) => {
    await expectSearchIds(toE164(number), [personByCase[personKey]]);
  });

  it('deduplicates a value repeated in primary/additional and two custom phone fields', async () => {
    await expectSearchIds(toE164('4155550105'), [
      personByCase.standardDuplicate,
    ]);
    await expectSearchIds(toE164('4155550112'), [personByCase.customDuplicate]);
  });

  it('does not search non-phone fields or Company phone fields', async () => {
    await expectSearchIds(toE164('4155550116'), []);
    await expectSearchIds(toE164('4155550118'), []);
    await expectSearchIds(toE164('4155550119'), []);
    await expectSearchIds(toE164('4155550101'), [personByCase.standardPrimary]);
    await expectSearchIds(toE164('4155550199'), []);
  });

  it('normalizes formatted and country-qualified national input, and rejects invalid/ambiguous input', async () => {
    await expectSearchIds('+1 (415) 555-0101', [personByCase.standardPrimary]);
    await expectSearchIds('4155550101', [personByCase.standardPrimary], 'US');

    const ambiguous = await searchPeopleByPhone({
      phoneNumber: '4155550101',
      limit: 10,
    });
    const invalid = await searchPeopleByPhone({
      phoneNumber: 'not-a-phone',
      limit: 10,
    });

    expect(ambiguous.errors).toBeDefined();
    expect(invalid.errors).toBeDefined();
  });

  it('returns stable ascending-ID pagination without duplicate results', async () => {
    const expectedIds = [
      personByCase.paginationOne,
      personByCase.paginationTwo,
    ].sort();
    const first = await searchPeopleByPhone({
      phoneNumber: toE164('4155550117'),
      limit: 1,
    });

    expect(first.errors).toBeUndefined();
    expect(
      first.data?.searchPeopleByPhone.edges.map(({ node }) => node.recordId),
    ).toEqual([expectedIds[0]]);
    expect(first.data?.searchPeopleByPhone.pageInfo.hasNextPage).toBe(true);

    const second = await searchPeopleByPhone({
      phoneNumber: toE164('4155550117'),
      limit: 1,
      after: first.data?.searchPeopleByPhone.pageInfo.endCursor ?? undefined,
    });

    expect(second.errors).toBeUndefined();
    expect(
      second.data?.searchPeopleByPhone.edges.map(({ node }) => node.recordId),
    ).toEqual([expectedIds[1]]);
    expect(second.data?.searchPeopleByPhone.pageInfo.hasNextPage).toBe(false);
  });

  it('updates primary/additional values and leaves generic search behavior unchanged', async () => {
    const recordId = personByCase.standardPrimary;
    const updateResponse = await makeGraphqlAPIRequest(
      updateOneOperationFactory({
        objectMetadataSingularName: 'person',
        recordId,
        gqlFields: 'id',
        data: {
          phones: {
            ...usPhone('4155550120'),
            additionalPhones: [additionalUsPhone('4155550121')],
          },
        },
      }),
    );

    expect(updateResponse.body.errors).toBeUndefined();
    await expectSearchIds(toE164('4155550101'), []);
    await expectSearchIds(toE164('4155550120'), [recordId]);
    await expectSearchIds(toE164('4155550121'), [recordId]);

    const removeResponse = await makeGraphqlAPIRequest(
      updateOneOperationFactory({
        objectMetadataSingularName: 'person',
        recordId,
        gqlFields: 'id',
        data: {
          phones: {
            primaryPhoneNumber: '',
            primaryPhoneCallingCode: '',
            primaryPhoneCountryCode: '',
            additionalPhones: [],
          },
        },
      }),
    );

    expect(removeResponse.body.errors).toBeUndefined();
    await expectSearchIds(toE164('4155550120'), []);
    await expectSearchIds(toE164('4155550121'), []);

    const generic = await search({
      searchInput: `GenericPhoneControl${runSuffix}`,
      includedObjectNameSingulars: ['person'],
      limit: 10,
      expectToFail: false,
    });

    expect(
      generic.data.search.edges.map((edge) => edge.node.recordId),
    ).toContain(personByCase.nonPhoneOnly);
  });
});
