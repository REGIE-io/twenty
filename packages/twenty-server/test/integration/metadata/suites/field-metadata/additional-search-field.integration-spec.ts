import { isDefined } from 'twenty-shared/utils';

import { createManyOperation } from 'test/integration/graphql/utils/create-many-operation.util';
import { search } from 'test/integration/graphql/utils/search.util';
import { createOneFieldMetadata } from 'test/integration/metadata/suites/field-metadata/utils/create-one-field-metadata.util';
import { updateOneFieldMetadata } from 'test/integration/metadata/suites/field-metadata/utils/update-one-field-metadata.util';
import { deleteOneFieldMetadata } from 'test/integration/metadata/suites/field-metadata/utils/delete-one-field-metadata.util';
import { findManyObjectMetadata } from 'test/integration/metadata/suites/object-metadata/utils/find-many-object-metadata.util';
import { jestExpectToBeDefined } from 'test/utils/jest-expect-to-be-defined.util.test';
import {
  FieldMetadataType,
  type AdditionalSearchSettings,
} from 'twenty-shared/types';

// The only test that executes the generated SQL. Everything else in this feature asserts
// on expression *strings*; Postgres is the only thing that can say whether a generated
// column is legal, whether a record is findable by a dropdown label it never stores, and
// whether relabelling an option actually refreshes the index.
describe('Additional searchable field', () => {
  let testObjectMetadataId: string;
  let tierFieldMetadataId: string;
  const createdFieldMetadataIds: string[] = [];
  let tierOptionIds: Record<string, string> = {};

  // The marker's target enum only covers person, account, task and calendar_event, and the
  // handler cross-checks it against the object's real name. A custom object can therefore
  // never carry an additionally searchable field, so this runs against the standard company object,
  // which `target: 'account'` maps to.
  const OBJECT_NAME_SINGULAR = 'company';
  const OBJECT_NAME_PLURAL = 'companies';
  const TIER_FIELD_NAME = 'additionalTier';
  const RECORD_NAME_VALUE = 'AdditionalSearchNameToken11';

  // A label a user would plausibly type, carrying two characters that isSafeTsVectorExpression
  // rejects anywhere in the expression, quoted or not.
  const GOLD_LABEL = 'Gold -- under $10k';
  const GOLD_VALUE = 'GOLD';
  // Carries an apostrophe on purpose (the DDL-escaping case) but is otherwise a token no
  // seeded company can contain: this suite now runs against the standard company object,
  // where a common word like "Owner" matches seed data and makes exact counts meaningless.
  const SILVER_LABEL = "O'Brien zzsilvertoken";
  const SILVER_VALUE = 'SILVER';

  // Typed rather than inline: an object literal would widen `version` to number and
  // `target` to string, which the settings slot rightly refuses.
  const searchableMarker: AdditionalSearchSettings = {
    additionalSearch: { version: 1, target: 'account', searchable: true },
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
    const { objects } = await findManyObjectMetadata({
      expectToFail: false,
      input: { filter: {}, paging: { first: 100 } },
      gqlFields: `id nameSingular`,
    });

    const companyObject = objects.find(
      (object) => object.nameSingular === OBJECT_NAME_SINGULAR,
    );

    jestExpectToBeDefined(companyObject);

    testObjectMetadataId = companyObject.id;
  });

  afterAll(async () => {
    // company is a standard object, so only the fields this suite added are removed.
    // A field has to be deactivated before it can be deleted.
    for (const fieldMetadataId of createdFieldMetadataIds) {
      await updateOneFieldMetadata({
        expectToFail: false,
        gqlFields: `id`,
        input: {
          idToUpdate: fieldMetadataId,
          updatePayload: { isActive: false },
        },
      });
      await deleteOneFieldMetadata({
        expectToFail: false,
        input: { idToDelete: fieldMetadataId },
      });
    }
  });

  it('accepts a generated column for a marked dropdown, and finds a record by its option label', async () => {
    const {
      data: {
        createOneField: { id: tierFieldId, options: createdOptions },
      },
    } = await createOneFieldMetadata({
      expectToFail: false,
      input: {
        name: TIER_FIELD_NAME,
        label: 'Additional Tier',
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
      gqlFields: `id name type options`,
    });

    tierFieldMetadataId = tierFieldId;
    createdFieldMetadataIds.push(tierFieldId);
    // Relabelling has to reuse the option's server-assigned id. The options update maps old
    // values to new ones BY ID, so a payload with fresh ids reads as "remove one option, add
    // another", the value mapping comes out empty, and the column's data is dropped instead
    // of migrated. Stored identity is the id, not the value.
    tierOptionIds = Object.fromEntries(
      (createdOptions ?? []).flatMap((option) =>
        isDefined(option.id) ? [[option.value, option.id] as const] : [],
      ),
    );

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
        { name: 'AdditionalSearchSilverToken22', [TIER_FIELD_NAME]: SILVER_VALUE },
      ],
      expectToFail: false,
    });

    expect(await searchFor('zzsilvertoken')).toBe(1);
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
              id: tierOptionIds[GOLD_VALUE],
              label: 'Platinum tier',
              value: GOLD_VALUE,
              position: 0,
              color: 'green',
            },
            {
              id: tierOptionIds[SILVER_VALUE],
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
    // "under" appears only in the OLD label, never in the stored value, so it isolates the
    // label half of the projection. Searching "Gold" would be useless here: the stored value
    // GOLD is still indexed and to_tsvector('simple', ...) lowercases, so it would match
    // whether or not the relabel took effect.
    expect(await searchFor('under')).toBe(0);
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
    const UNMARKED_FIELD_NAME = 'additionalUnmarkedTier';

    const {
      data: {
        createOneField: { id: unmarkedFieldId },
      },
    } = await createOneFieldMetadata({
      expectToFail: false,
      input: {
        name: UNMARKED_FIELD_NAME,
        label: 'Unmarked Tier',
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

    createdFieldMetadataIds.push(unmarkedFieldId);

    await createManyOperation({
      objectMetadataSingularName: OBJECT_NAME_SINGULAR,
      objectMetadataPluralName: OBJECT_NAME_PLURAL,
      gqlFields: `id name ${UNMARKED_FIELD_NAME}`,
      data: [
        { name: 'AdditionalSearchUnmarkedToken33', [UNMARKED_FIELD_NAME]: 'BRONZE' },
      ],
      expectToFail: false,
    });

    // The record name deliberately avoids the word searched for: `name` is in the search
    // surface by default, so a name containing "Bronze" would match through it and hide
    // whether the dropdown was indexed at all.
    expect(await searchFor('Bronze')).toBe(0);
  });

  // Regression guard for the enum-swap fix. Changing enum options renames the column aside
  // and drops it, which Postgres refuses while a generated column reads it, so the
  // searchVector is dropped first and recreated by the rebuild an options change schedules.
  // That rebuild is only scheduled for a field that is actually indexed, so the drop is
  // guarded on the field having a searchFieldMetadata row. Without that guard, editing the
  // options of ANY ordinary enum field would drop its object's searchVector and never put
  // it back, silently breaking search for the whole object.
  it('keeps the object searchable after an unmarked dropdown changes its options', async () => {
    const OPTIONS_ONLY_FIELD_NAME = 'additionalOptionsOnlyTier';
    const RECORD_NAME = 'AdditionalSearchGuardToken44';

    const {
      data: {
        createOneField: { id: optionsOnlyFieldId },
      },
    } = await createOneFieldMetadata({
      expectToFail: false,
      input: {
        name: OPTIONS_ONLY_FIELD_NAME,
        label: 'Options Only Tier',
        type: FieldMetadataType.SELECT,
        objectMetadataId: testObjectMetadataId,
        isLabelSyncedWithName: false,
        options: [
          { label: 'Before', value: 'BEFORE', position: 0, color: 'blue' },
        ],
      },
      gqlFields: `id name type`,
    });

    createdFieldMetadataIds.push(optionsOnlyFieldId);

    await createManyOperation({
      objectMetadataSingularName: OBJECT_NAME_SINGULAR,
      objectMetadataPluralName: OBJECT_NAME_PLURAL,
      gqlFields: `id name ${OPTIONS_ONLY_FIELD_NAME}`,
      data: [{ name: RECORD_NAME, [OPTIONS_ONLY_FIELD_NAME]: 'BEFORE' }],
      expectToFail: false,
    });

    // Baseline: the object's own name field is indexed, so the record is reachable.
    expect(await searchFor(RECORD_NAME)).toBe(1);

    await updateOneFieldMetadata({
      expectToFail: false,
      gqlFields: `id`,
      input: {
        idToUpdate: optionsOnlyFieldId,
        updatePayload: {
          options: [
            { label: 'After', value: 'BEFORE', position: 0, color: 'blue' },
          ],
        },
      },
    });

    // The searchVector must still exist and still index the name field. A dropped-and-never
    // recreated vector would make this 0 while nothing else reported a problem.
    expect(await searchFor(RECORD_NAME)).toBe(1);
    // The unmarked field's label stays out of the surface, before and after the edit.
    expect(await searchFor('After')).toBe(0);
  });
});
