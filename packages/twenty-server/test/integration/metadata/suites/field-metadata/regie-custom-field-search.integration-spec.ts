import { createManyOperation } from 'test/integration/graphql/utils/create-many-operation.util';
import { search } from 'test/integration/graphql/utils/search.util';
import { createOneFieldMetadata } from 'test/integration/metadata/suites/field-metadata/utils/create-one-field-metadata.util';
import { updateOneFieldMetadata } from 'test/integration/metadata/suites/field-metadata/utils/update-one-field-metadata.util';
import { createOneObjectMetadata } from 'test/integration/metadata/suites/object-metadata/utils/create-one-object-metadata.util';
import { deleteOneObjectMetadata } from 'test/integration/metadata/suites/object-metadata/utils/delete-one-object-metadata.util';
import { updateOneObjectMetadata } from 'test/integration/metadata/suites/object-metadata/utils/update-one-object-metadata.util';
import {
  FieldMetadataType,
  type RegieCustomFieldSettings,
} from 'twenty-shared/types';

// The only test that executes the generated SQL. Everything else in this feature asserts
// on expression *strings*; Postgres is the only thing that can say whether a generated
// column is legal, whether a record is findable by a dropdown label it never stores, and
// whether relabelling an option actually refreshes the index.
describe('Regie custom field search', () => {
  let testObjectMetadataId: string;
  let tierFieldMetadataId: string;

  const OBJECT_NAME_SINGULAR = 'regieSearchObject';
  const OBJECT_NAME_PLURAL = 'regieSearchObjects';
  const TIER_FIELD_NAME = 'regieTier';
  const RECORD_NAME_VALUE = 'RegieSearchNameToken11';

  // A label a user would plausibly type, carrying two characters that isSafeTsVectorExpression
  // rejects anywhere in the expression, quoted or not.
  const GOLD_LABEL = 'Gold -- under $10k';
  const GOLD_VALUE = 'GOLD';
  const SILVER_LABEL = "Owner's silver";
  const SILVER_VALUE = 'SILVER';

  // Typed rather than inline: an object literal would widen `version` to number and
  // `target` to string, which the settings slot rightly refuses.
  const searchableMarker: RegieCustomFieldSettings = {
    regieCustomField: { version: 1, target: 'account', searchable: true },
  };

  const searchFor = async (searchInput: string) => {
    const result = await search({
      searchInput,
      includedObjectNameSingulars: [OBJECT_NAME_SINGULAR],
      limit: 10,
      expectToFail: false,
    });

    return result.data.search.edges.length;
  };

  beforeAll(async () => {
    const {
      data: {
        createOneObject: { id: objectMetadataId },
      },
    } = await createOneObjectMetadata({
      expectToFail: false,
      input: {
        nameSingular: OBJECT_NAME_SINGULAR,
        namePlural: OBJECT_NAME_PLURAL,
        labelSingular: 'Regie Search Object',
        labelPlural: 'Regie Search Objects',
        icon: 'IconSearch',
        isLabelSyncedWithName: false,
      },
    });

    testObjectMetadataId = objectMetadataId;
  });

  afterAll(async () => {
    await updateOneObjectMetadata({
      expectToFail: false,
      input: {
        idToUpdate: testObjectMetadataId,
        updatePayload: { isActive: false },
      },
    });
    await deleteOneObjectMetadata({
      expectToFail: false,
      input: { idToDelete: testObjectMetadataId },
    });
  });

  it('accepts a generated column for a marked dropdown, and finds a record by its option label', async () => {
    const {
      data: {
        createOneField: { id: tierFieldId },
      },
    } = await createOneFieldMetadata({
      expectToFail: false,
      input: {
        name: TIER_FIELD_NAME,
        label: 'Regie Tier',
        type: FieldMetadataType.SELECT,
        objectMetadataId: testObjectMetadataId,
        isLabelSyncedWithName: false,
        options: [
          { label: GOLD_LABEL, value: GOLD_VALUE, position: 0, color: 'green' },
          {
            label: SILVER_LABEL,
            value: SILVER_VALUE,
            position: 1,
            color: 'gray',
          },
        ],
        settings: searchableMarker,
      },
      gqlFields: `id name type`,
    });

    tierFieldMetadataId = tierFieldId;

    await createManyOperation({
      objectMetadataSingularName: OBJECT_NAME_SINGULAR,
      objectMetadataPluralName: OBJECT_NAME_PLURAL,
      gqlFields: `id name ${TIER_FIELD_NAME}`,
      data: [{ name: RECORD_NAME_VALUE, [TIER_FIELD_NAME]: GOLD_VALUE }],
      expectToFail: false,
    });

    // The stored value is GOLD; a user searches the label they can see.
    expect(await searchFor('Gold')).toBe(1);
    // The stored value itself still matches, since both halves are indexed.
    expect(await searchFor(GOLD_VALUE)).toBe(1);
    // A different option's label must not match this record.
    expect(await searchFor('silver')).toBe(0);
  });

  // Proves the escaping and the sanitising: an apostrophe would break the DDL outright, and
  // a `$` or `--` would be rejected by isSafeTsVectorExpression before the column was built.
  it('survives option labels containing quotes and expression-unsafe characters', async () => {
    await createManyOperation({
      objectMetadataSingularName: OBJECT_NAME_SINGULAR,
      objectMetadataPluralName: OBJECT_NAME_PLURAL,
      gqlFields: `id name ${TIER_FIELD_NAME}`,
      data: [
        { name: 'RegieSearchSilverToken22', [TIER_FIELD_NAME]: SILVER_VALUE },
      ],
      expectToFail: false,
    });

    expect(await searchFor('Owner')).toBe(1);
  });

  // Proves the rebuild trigger: without it the index keeps the old label and nothing reports
  // a problem.
  it('reindexes on the new label when an option is relabelled', async () => {
    await updateOneFieldMetadata({
      expectToFail: false,
      gqlFields: `id`,
      input: {
        idToUpdate: tierFieldMetadataId,
        updatePayload: {
          options: [
            {
              label: 'Platinum tier',
              value: GOLD_VALUE,
              position: 0,
              color: 'green',
            },
            {
              label: SILVER_LABEL,
              value: SILVER_VALUE,
              position: 1,
              color: 'gray',
            },
          ],
        },
      },
    });

    expect(await searchFor('Platinum')).toBe(1);
    // The old label is gone from the index rather than lingering beside the new one.
    expect(await searchFor('Gold')).toBe(0);
  });

  it('stops matching once the field is archived', async () => {
    await updateOneFieldMetadata({
      expectToFail: false,
      gqlFields: `id`,
      input: {
        idToUpdate: tierFieldMetadataId,
        updatePayload: { isActive: false },
      },
    });

    expect(await searchFor('Platinum')).toBe(0);
    // The record itself is untouched; only the field left the search surface.
    expect(await searchFor(RECORD_NAME_VALUE)).toBe(1);
  });

  it('matches again once the field is restored', async () => {
    await updateOneFieldMetadata({
      expectToFail: false,
      gqlFields: `id`,
      input: {
        idToUpdate: tierFieldMetadataId,
        updatePayload: { isActive: true },
      },
    });

    expect(await searchFor('Platinum')).toBe(1);
  });

  // The marker is what admits a field to the search surface, so an unmarked dropdown must
  // behave exactly as it did before this feature existed.
  it('leaves an unmarked dropdown out of the search surface', async () => {
    const UNMARKED_FIELD_NAME = 'regieUnmarkedTier';

    await createOneFieldMetadata({
      expectToFail: false,
      input: {
        name: UNMARKED_FIELD_NAME,
        label: 'Regie Unmarked Tier',
        type: FieldMetadataType.SELECT,
        objectMetadataId: testObjectMetadataId,
        isLabelSyncedWithName: false,
        options: [
          {
            label: 'Bronze only',
            value: 'BRONZE',
            position: 0,
            color: 'orange',
          },
        ],
      },
      gqlFields: `id name type`,
    });

    await createManyOperation({
      objectMetadataSingularName: OBJECT_NAME_SINGULAR,
      objectMetadataPluralName: OBJECT_NAME_PLURAL,
      gqlFields: `id name ${UNMARKED_FIELD_NAME}`,
      data: [
        { name: 'RegieSearchBronzeToken33', [UNMARKED_FIELD_NAME]: 'BRONZE' },
      ],
      expectToFail: false,
    });

    expect(await searchFor('Bronze')).toBe(0);
  });
});
