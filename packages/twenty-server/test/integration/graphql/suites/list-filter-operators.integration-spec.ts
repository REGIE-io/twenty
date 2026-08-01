import { setupTestObjectsWithAllFieldTypes } from 'test/integration/graphql/suites/inputs-validation/utils/setup-test-objects-with-all-field-types.util';
import { destroyManyObjectsMetadata } from 'test/integration/graphql/suites/inputs-validation/utils/destroy-many-objects-metadata';
import { findManyOperationFactory } from 'test/integration/graphql/utils/find-many-operation-factory.util';
import { makeGraphqlAPIRequest } from 'test/integration/graphql/utils/make-graphql-api-request.util';

describe('list filter operators (integration)', () => {
  let objectMetadataId: string;
  let targetObjectMetadata1Id: string;
  let targetObjectMetadata2Id: string;
  let objectMetadataSingularName: string;
  let objectMetadataPluralName: string;

  beforeAll(async () => {
    const setup = await setupTestObjectsWithAllFieldTypes();

    objectMetadataId = setup.objectMetadataId;
    targetObjectMetadata1Id = setup.targetObjectMetadata1Id;
    targetObjectMetadata2Id = setup.targetObjectMetadata2Id;
    objectMetadataSingularName = setup.objectMetadataSingularName;
    objectMetadataPluralName = setup.objectMetadataPluralName;
  });

  afterAll(async () => {
    await destroyManyObjectsMetadata([
      objectMetadataId,
      targetObjectMetadata1Id,
      targetObjectMetadata2Id,
    ]);
  });

  const findByTextField = async (filter: object) => {
    const response = await makeGraphqlAPIRequest(
      findManyOperationFactory({
        objectMetadataSingularName,
        objectMetadataPluralName,
        gqlFields: 'id textField',
        filter,
      }),
    );

    return response;
  };

  it('translates in and notIn through the public record API', async () => {
    const included = await findByTextField({ textField: { in: ['test'] } });
    const excluded = await findByTextField({ textField: { notIn: ['test'] } });
    const positivelyExcluded = await findByTextField({
      textField: { notIn: ['other'] },
    });

    expect(included.body.errors).toBeUndefined();
    expect(included.body.data[objectMetadataPluralName].edges).toEqual([
      expect.objectContaining({
        node: expect.objectContaining({ textField: 'test' }),
      }),
    ]);
    // SQL NOT IN intentionally does not match a record whose nullable field is
    // absent, so the second persisted fixture record remains excluded too.
    expect(excluded.body.errors).toBeUndefined();
    expect(excluded.body.data[objectMetadataPluralName].edges).toEqual([]);
    expect(positivelyExcluded.body.errors).toBeUndefined();
    expect(
      positivelyExcluded.body.data[objectMetadataPluralName].edges,
    ).toEqual([
      expect.objectContaining({
        node: expect.objectContaining({ textField: 'test' }),
      }),
    ]);
  });

  it('rejects empty lists before generating a record query', async () => {
    const included = await findByTextField({ textField: { in: [] } });
    const excluded = await findByTextField({ textField: { notIn: [] } });

    expect(included.body.errors?.[0].message).toContain(
      'Expected non-empty array',
    );
    expect(excluded.body.errors?.[0].message).toContain(
      'Expected non-empty array',
    );
  });
});
