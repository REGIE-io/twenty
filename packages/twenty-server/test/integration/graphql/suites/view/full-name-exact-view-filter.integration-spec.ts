import gql from 'graphql-tag';
import { createManyOperationFactory } from 'test/integration/graphql/utils/create-many-operation-factory.util';
import { deleteManyOperationFactory } from 'test/integration/graphql/utils/delete-many-operation-factory.util';
import { makeGraphqlAPIRequest } from 'test/integration/graphql/utils/make-graphql-api-request.util';
import { findManyObjectMetadata } from 'test/integration/metadata/suites/object-metadata/utils/find-many-object-metadata.util';
import { createOneViewFilter } from 'test/integration/metadata/suites/view-filter/utils/create-one-view-filter.util';
import { destroyOneViewFilter } from 'test/integration/metadata/suites/view-filter/utils/destroy-one-view-filter.util';
import { createOneView } from 'test/integration/metadata/suites/view/utils/create-one-view.util';
import { destroyOneView } from 'test/integration/metadata/suites/view/utils/destroy-one-view.util';
import { jestExpectToBeDefined } from 'test/utils/jest-expect-to-be-defined.util.test';
import {
  FieldMetadataType,
  ViewFilterOperand,
  ViewType,
} from 'twenty-shared/types';
import {
  type FieldShared,
  turnRecordFilterIntoRecordGqlOperationFilter,
} from 'twenty-shared/utils';

const TEST_PERSON_IDS = {
  LOWER_CASE: '20202020-dddd-4000-8000-200000000001',
  PREFIX_ONLY: '20202020-dddd-4000-8000-200000000002',
  LONGER_VALUE: '20202020-dddd-4000-8000-200000000003',
  LITERAL_WILDCARDS: '20202020-dddd-4000-8000-200000000004',
  WILDCARD_FALSE_POSITIVE: '20202020-dddd-4000-8000-200000000005',
} as const;

const ALL_TEST_PERSON_IDS = Object.values(TEST_PERSON_IDS);

describe('FULL_NAME exact view filter persistence and record query', () => {
  let personObjectMetadataId: string;
  let personNameFieldMetadataId: string;
  let testViewId: string;
  let testViewFilterId: string | undefined;

  beforeAll(async () => {
    const { objects } = await findManyObjectMetadata({
      expectToFail: false,
      input: {
        filter: {},
        paging: { first: 1000 },
      },
      gqlFields: `
        id
        nameSingular
        fieldsList {
          id
          name
          type
          label
        }
      `,
    });

    jestExpectToBeDefined(objects);

    const personObject = objects.find(
      (object: { nameSingular: string }) => object.nameSingular === 'person',
    );

    jestExpectToBeDefined(personObject);
    personObjectMetadataId = personObject.id;

    const personNameField = personObject.fieldsList?.find(
      (field: { name: string; type: string }) =>
        field.name === 'name' && field.type === FieldMetadataType.FULL_NAME,
    );

    jestExpectToBeDefined(personNameField);
    personNameFieldMetadataId = personNameField.id;

    const { data, errors } = await createOneView({
      expectToFail: false,
      input: {
        name: 'FULL_NAME Exact View Filter Integration Test',
        objectMetadataId: personObjectMetadataId,
        type: ViewType.TABLE,
        icon: 'IconFilter',
      },
    });

    expect(errors).toBeUndefined();
    testViewId = data.createView.id;

    const response = await makeGraphqlAPIRequest(
      createManyOperationFactory({
        objectMetadataSingularName: 'person',
        objectMetadataPluralName: 'people',
        gqlFields: 'id name',
        data: [
          {
            id: TEST_PERSON_IDS.LOWER_CASE,
            name: { firstName: 'mary jane', lastName: 'Watson' },
          },
          {
            id: TEST_PERSON_IDS.PREFIX_ONLY,
            name: { firstName: 'Mary', lastName: 'Watson' },
          },
          {
            id: TEST_PERSON_IDS.LONGER_VALUE,
            name: { firstName: 'Mary Jane Ann', lastName: 'Watson' },
          },
          {
            id: TEST_PERSON_IDS.LITERAL_WILDCARDS,
            name: { firstName: '100%_\\Path', lastName: 'Watson' },
          },
          {
            id: TEST_PERSON_IDS.WILDCARD_FALSE_POSITIVE,
            name: { firstName: '100anythingXPath', lastName: 'Watson' },
          },
        ],
        upsert: true,
      }),
    );

    expect(response.body.errors).toBeUndefined();
  });

  afterEach(async () => {
    if (!testViewFilterId) {
      return;
    }

    await destroyOneViewFilter({
      expectToFail: false,
      input: { id: testViewFilterId },
    });
    testViewFilterId = undefined;
  });

  afterAll(async () => {
    await makeGraphqlAPIRequest(
      deleteManyOperationFactory({
        objectMetadataSingularName: 'person',
        objectMetadataPluralName: 'people',
        gqlFields: 'id',
        filter: { id: { in: ALL_TEST_PERSON_IDS } },
      }),
    );

    await destroyOneView({
      expectToFail: false,
      viewId: testViewId,
    });
  });

  it.each([
    {
      filterValue: 'Mary Jane',
      expectedPersonIds: [TEST_PERSON_IDS.LOWER_CASE],
      description: 'matches a whole first name without regard to case',
    },
    {
      filterValue: '100%_\\Path',
      expectedPersonIds: [TEST_PERSON_IDS.LITERAL_WILDCARDS],
      description: 'treats ILIKE metacharacters as literal characters',
    },
  ])('$description', async ({ filterValue, expectedPersonIds }) => {
    const { data, errors } = await createOneViewFilter({
      expectToFail: false,
      input: {
        viewId: testViewId,
        fieldMetadataId: personNameFieldMetadataId,
        subFieldName: 'firstName',
        operand: ViewFilterOperand.IS,
        value: filterValue,
      },
    });

    expect(errors).toBeUndefined();
    testViewFilterId = data.createViewFilter.id;

    const fieldMetadataItemById = new Map<string, FieldShared>([
      [
        personNameFieldMetadataId,
        {
          id: personNameFieldMetadataId,
          name: 'name',
          type: FieldMetadataType.FULL_NAME,
          label: 'Name',
        },
      ],
    ]);

    const recordGqlOperationFilter =
      turnRecordFilterIntoRecordGqlOperationFilter({
        filterValueDependencies: {},
        fieldMetadataItemById,
        recordFilter: {
          fieldMetadataId: personNameFieldMetadataId,
          subFieldName: 'firstName',
          operand: ViewFilterOperand.IS,
          type: 'FULL_NAME',
          value: filterValue,
        },
      });

    jestExpectToBeDefined(recordGqlOperationFilter);

    const response = await makeGraphqlAPIRequest({
      query: gql`
        query People($filter: PersonFilterInput) {
          people(filter: $filter, first: 50) {
            edges {
              node {
                id
              }
            }
          }
        }
      `,
      variables: {
        filter: {
          and: [{ id: { in: ALL_TEST_PERSON_IDS } }, recordGqlOperationFilter],
        },
      },
    });

    expect(response.body.errors).toBeUndefined();

    const returnedPersonIds = response.body.data.people.edges.map(
      (edge: { node: { id: string } }) => edge.node.id,
    );

    expect(returnedPersonIds.sort()).toEqual(expectedPersonIds.sort());
  });
});
