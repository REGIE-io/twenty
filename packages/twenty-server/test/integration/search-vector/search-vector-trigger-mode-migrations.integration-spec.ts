import { createOneOperation } from 'test/integration/graphql/utils/create-one-operation.util';
import { makeGraphqlAPIRequest } from 'test/integration/graphql/utils/make-graphql-api-request.util';
import { search } from 'test/integration/graphql/utils/search.util';
import { updateOneOperationFactory } from 'test/integration/graphql/utils/update-one-operation-factory.util';
import { createOneFieldMetadata } from 'test/integration/metadata/suites/field-metadata/utils/create-one-field-metadata.util';
import { deleteOneFieldMetadata } from 'test/integration/metadata/suites/field-metadata/utils/delete-one-field-metadata.util';
import { updateOneFieldMetadata } from 'test/integration/metadata/suites/field-metadata/utils/update-one-field-metadata.util';
import { createOneObjectMetadata } from 'test/integration/metadata/suites/object-metadata/utils/create-one-object-metadata.util';
import { deleteOneObjectMetadata } from 'test/integration/metadata/suites/object-metadata/utils/delete-one-object-metadata.util';
import { updateOneObjectMetadata } from 'test/integration/metadata/suites/object-metadata/utils/update-one-object-metadata.util';
import { getAppProviderByClassName } from 'test/integration/utils/get-app-provider-by-class-name.util';
import { FieldMetadataType } from 'twenty-shared/types';
import { isDefined } from 'twenty-shared/utils';

import {
  buildSearchVectorTriggerStatements,
  getSearchVectorFunctionName,
} from 'src/engine/core-modules/search-vector-trigger/utils/build-search-vector-trigger-statements.util';
import { type SearchVectorBackfillService } from 'src/engine/core-modules/search-vector-trigger/services/search-vector-backfill.service';
import { type SearchVectorTriggerConversionService } from 'src/engine/core-modules/search-vector-trigger/services/search-vector-trigger-conversion.service';
import { isSearchVectorTriggerMode } from 'src/engine/core-modules/search-vector-trigger/utils/search-vector-trigger-maintenance.util';
import { getDefaultFlatFieldMetadata } from 'src/engine/metadata-modules/flat-field-metadata/utils/get-default-flat-field-metadata-from-create-field-input.util';
import { buildFlatSearchFieldMetadataForField } from 'src/engine/metadata-modules/flat-search-field-metadata/utils/build-flat-search-field-metadata-for-field.util';
import { getWorkspaceSchemaName } from 'src/engine/workspace-datasource/utils/get-workspace-schema-name.util';
import { type FlatFieldMetadata } from 'src/engine/metadata-modules/flat-field-metadata/types/flat-field-metadata.type';
import { type FlatSearchFieldMetadata } from 'src/engine/metadata-modules/flat-search-field-metadata/types/flat-search-field-metadata.type';
import { type WorkspaceCacheService } from 'src/engine/workspace-cache/services/workspace-cache.service';
import { type WorkspaceMigrationValidateBuildAndRunService } from 'src/engine/workspace-manager/workspace-migration/services/workspace-migration-validate-build-and-run-service';

// Nothing is converted in production yet, so this suite converts its own custom table by
// hand and checks that every field and object change keeps it working in trigger mode.
const OBJECT = {
  nameSingular: 'svTriggerModeItem',
  namePlural: 'svTriggerModeItems',
};
const RENAMED_OBJECT = {
  nameSingular: 'svTriggerModeThing',
  namePlural: 'svTriggerModeThings',
};
const GENERATED_OBJECT = {
  nameSingular: 'svGeneratedModeItem',
  namePlural: 'svGeneratedModeItems',
};
const BACKFILL_OBJECT = {
  nameSingular: 'svBackfillItem',
  namePlural: 'svBackfillItems',
};
const REPAIR_OBJECT = {
  nameSingular: 'svRepairItem',
  namePlural: 'svRepairItems',
};
const CONVERTED_WORKSPACE_OBJECT = {
  nameSingular: 'svConvertedWorkspaceItem',
  namePlural: 'svConvertedWorkspaceItems',
};
const SELF_HEAL_OBJECT = {
  nameSingular: 'svSelfHealItem',
  namePlural: 'svSelfHealItems',
};

type CreatedObject = { id: string; workspaceId: string; schemaName: string };

const tableNameOf = (nameSingular: string) => `_${nameSingular}`;

const query = <TRow>(sql: string, parameters?: unknown[]): Promise<TRow[]> =>
  global.testDataSource.query(sql, parameters);

// Jobs cascade with their object, but a failed object delete would leave them to later suites.
const deleteBackfillJobs = async (objectMetadataIds: string[]) => {
  await query(
    `DELETE FROM core."searchVectorBackfillJob" WHERE "objectMetadataId" = ANY($1)`,
    [objectMetadataIds],
  );
};

const createObject = async ({
  nameSingular,
  namePlural,
}: {
  nameSingular: string;
  namePlural: string;
}): Promise<CreatedObject> => {
  const {
    data: {
      createOneObject: { id },
    },
  } = await createOneObjectMetadata({
    expectToFail: false,
    input: {
      nameSingular,
      namePlural,
      labelSingular: nameSingular,
      labelPlural: namePlural,
      icon: 'IconSearch',
      isLabelSyncedWithName: false,
    },
  });

  const [{ workspaceId }] = await query<{ workspaceId: string }>(
    `SELECT "workspaceId" FROM core."objectMetadata" WHERE id = $1`,
    [id],
  );

  return { id, workspaceId, schemaName: getWorkspaceSchemaName(workspaceId) };
};

const deleteObject = async (objectMetadataId: string) => {
  await updateOneObjectMetadata({
    expectToFail: false,
    input: { idToUpdate: objectMetadataId, updatePayload: { isActive: false } },
  });
  await deleteOneObjectMetadata({
    expectToFail: false,
    input: { idToDelete: objectMetadataId },
  });
};

// The test DB is shared, so an object left by an earlier failed run would block creation.
const deleteLeftoverObjects = async () => {
  const leftoverObjects = await query<{ id: string }>(
    `SELECT id FROM core."objectMetadata" WHERE "nameSingular" = ANY($1)`,
    [
      [
        OBJECT.nameSingular,
        RENAMED_OBJECT.nameSingular,
        GENERATED_OBJECT.nameSingular,
        BACKFILL_OBJECT.nameSingular,
        REPAIR_OBJECT.nameSingular,
        CONVERTED_WORKSPACE_OBJECT.nameSingular,
        SELF_HEAL_OBJECT.nameSingular,
      ],
    ],
  );

  for (const { id } of leftoverObjects) {
    await deleteObject(id);
  }
};

const createField = async (input: {
  objectMetadataId: string;
  name: string;
  type: FieldMetadataType;
  options?: Array<{
    label: string;
    value: string;
    position: number;
    color: string;
  }>;
}) => {
  const {
    data: { createOneField },
  } = await createOneFieldMetadata({
    expectToFail: false,
    input: { ...input, label: input.name, isLabelSyncedWithName: false },
    gqlFields: `id name options`,
  });

  return createOneField;
};

// Custom objects index their label identifier, which is the API's way to make a TEXT field
// searchable on them.
const makeLabelIdentifier = async (
  objectMetadataId: string,
  fieldMetadataId: string,
) => {
  await updateOneObjectMetadata({
    expectToFail: false,
    input: {
      idToUpdate: objectMetadataId,
      updatePayload: { labelIdentifierFieldMetadataId: fieldMetadataId },
    },
  });
};

const runLegacyMigration = async (
  args: Omit<
    Parameters<
      WorkspaceMigrationValidateBuildAndRunService['validateBuildAndRunLegacyWorkspaceMigration']
    >[0],
    'isSystemBuild'
  >,
) => {
  const result =
    await getAppProviderByClassName<WorkspaceMigrationValidateBuildAndRunService>(
      'WorkspaceMigrationValidateBuildAndRunService',
    ).validateBuildAndRunLegacyWorkspaceMigration({
      ...args,
      isSystemBuild: true,
    });

  expect(result.status).toBe('success');
};

const getApplicationUniversalIdentifier = async (objectMetadataId: string) => {
  const [{ universalIdentifier }] = await query<{
    universalIdentifier: string;
  }>(
    `SELECT a."universalIdentifier" FROM core."objectMetadata" o
       JOIN core."application" a ON a.id = o."applicationId"
      WHERE o.id = $1`,
    [objectMetadataId],
  );

  return universalIdentifier;
};

// Field and search rows of one object, read from the cache the runner itself uses.
const getObjectFlatEntities = async (
  objectMetadataId: string,
  workspaceId: string,
) => {
  const { flatFieldMetadataMaps, flatSearchFieldMetadataMaps } =
    await getAppProviderByClassName<WorkspaceCacheService>(
      'WorkspaceCacheService',
    ).getOrRecompute(workspaceId, [
      'flatFieldMetadataMaps',
      'flatSearchFieldMetadataMaps',
    ]);

  const flatFieldMetadatas = Object.values(
    flatFieldMetadataMaps.byUniversalIdentifier,
  ).filter(
    (flatFieldMetadata): flatFieldMetadata is FlatFieldMetadata =>
      flatFieldMetadata?.objectMetadataId === objectMetadataId,
  );

  const findFieldByName = (name: string) => {
    const flatFieldMetadata = flatFieldMetadatas.find(
      (field) => field.name === name,
    );

    if (!isDefined(flatFieldMetadata)) {
      throw new Error(`Field ${name} not found`);
    }

    return flatFieldMetadata;
  };

  const findSearchFieldsOf = (fieldMetadataId: string) =>
    Object.values(flatSearchFieldMetadataMaps.byUniversalIdentifier).filter(
      (searchField): searchField is FlatSearchFieldMetadata =>
        searchField?.fieldMetadataId === fieldMetadataId,
    );

  return { findFieldByName, findSearchFieldsOf };
};

// The additional-search marker only targets standard objects, so a dropdown on a custom
// object is registered directly, the way the backfill commands do it.
const registerSearchField = async ({
  objectMetadataId,
  fieldMetadataId,
  workspaceId,
}: {
  objectMetadataId: string;
  fieldMetadataId: string;
  workspaceId: string;
}) => {
  const [identifiers] = await query<{
    objectUniversalIdentifier: string;
    applicationUniversalIdentifier: string;
    fieldUniversalIdentifier: string;
    tsVectorUniversalIdentifier: string;
  }>(
    `SELECT o."universalIdentifier" AS "objectUniversalIdentifier",
            a."universalIdentifier" AS "applicationUniversalIdentifier",
            f."universalIdentifier" AS "fieldUniversalIdentifier",
            v."universalIdentifier" AS "tsVectorUniversalIdentifier"
       FROM core."objectMetadata" o
       JOIN core."application" a ON a.id = o."applicationId"
       JOIN core."fieldMetadata" f ON f.id = $2
       JOIN core."fieldMetadata" v ON v."objectMetadataId" = o.id AND v.name = 'searchVector'
      WHERE o.id = $1`,
    [objectMetadataId, fieldMetadataId],
  );

  await runLegacyMigration({
    workspaceId,
    applicationUniversalIdentifier: identifiers.applicationUniversalIdentifier,
    allFlatEntityOperationByMetadataName: {
      searchFieldMetadata: {
        flatEntityToCreate: [
          buildFlatSearchFieldMetadataForField({
            flatObjectMetadata: {
              universalIdentifier: identifiers.objectUniversalIdentifier,
              applicationUniversalIdentifier:
                identifiers.applicationUniversalIdentifier,
            },
            flatFieldMetadata: {
              universalIdentifier: identifiers.fieldUniversalIdentifier,
            },
            tsVectorFlatFieldMetadata: {
              universalIdentifier: identifiers.tsVectorUniversalIdentifier,
            },
            position: 10,
          }),
        ],
        flatEntityToDelete: [],
        flatEntityToUpdate: [],
      },
    },
  });
};

const deleteField = async (fieldMetadataId: string) => {
  await updateOneFieldMetadata({
    expectToFail: false,
    gqlFields: `id`,
    input: { idToUpdate: fieldMetadataId, updatePayload: { isActive: false } },
  });
  await deleteOneFieldMetadata({
    expectToFail: false,
    input: { idToDelete: fieldMetadataId },
  });
};

const createRecord = async (
  nameSingular: string,
  data: Record<string, unknown>,
): Promise<string> => {
  const { data: response, errors } = await createOneOperation({
    objectMetadataSingularName: nameSingular,
    input: data,
    gqlFields: 'id',
  });

  expect(errors).toBeUndefined();

  return response.createOneResponse.id as string;
};

const updateRecord = async (
  nameSingular: string,
  recordId: string,
  data: Record<string, unknown>,
) => {
  const response = await makeGraphqlAPIRequest(
    updateOneOperationFactory({
      objectMetadataSingularName: nameSingular,
      gqlFields: 'id',
      recordId,
      data,
    }),
  );

  expect(response.body.errors).toBeUndefined();
};

const readAttGenerated = async (schemaName: string, tableName: string) => {
  const [{ attgenerated }] = await query<{ attgenerated: string }>(
    `SELECT attgenerated FROM pg_attribute
      WHERE attrelid = to_regclass($1) AND attname = 'searchVector' AND NOT attisdropped`,
    [`"${schemaName}"."${tableName}"`],
  );

  return attgenerated;
};

const isTriggerMode = async (schemaName: string, tableName: string) => {
  const queryRunner = global.testDataSource.createQueryRunner();

  try {
    return await isSearchVectorTriggerMode(queryRunner, {
      schemaName,
      tableName,
    });
  } finally {
    await queryRunner.release();
  }
};

const readFunctionDefinition = async (
  schemaName: string,
  tableName: string,
): Promise<string | null> => {
  const functionName = getSearchVectorFunctionName(tableName);
  const [{ definition }] = await query<{ definition: string | null }>(
    `SELECT pg_get_functiondef(to_regprocedure($1)) AS definition`,
    [`"${schemaName}"."${functionName}"()`],
  );

  return definition;
};

const vectorMatches = async (
  schemaName: string,
  tableName: string,
  recordId: string,
  token: string,
) => {
  const [{ matches }] = await query<{ matches: boolean }>(
    `SELECT COALESCE("searchVector" @@ to_tsquery('simple', $2), false) AS matches
       FROM "${schemaName}"."${tableName}" WHERE id = $1`,
    [recordId, token],
  );

  return matches;
};

const searchCount = async (nameSingular: string, searchInput: string) => {
  const result = await search({
    searchInput,
    includedObjectNameSingulars: [nameSingular],
    limit: 10,
    expectToFail: false,
  });

  return result.data.search.edges.length;
};

// A placeholder formula: the runner has to replace it with the real one.
const convertTableByHand = async (schemaName: string, tableName: string) => {
  const statements = buildSearchVectorTriggerStatements({
    schemaName,
    tableName,
    triggerRowExpression: `to_tsvector('simple', NULL)`,
  });

  await query(
    `ALTER TABLE "${schemaName}"."${tableName}" ALTER COLUMN "searchVector" DROP EXPRESSION`,
  );
  await query(statements.createFunction);
  await query(statements.dropTrigger);
  await query(statements.createTrigger);
};

describe('searchVector trigger mode across workspace migrations', () => {
  let object: CreatedObject;
  let tableName = tableNameOf(OBJECT.nameSingular);
  let firstRecordId: string;
  let tierFieldId: string;
  let tierOptionIds: Record<string, string> = {};
  let isObjectDeleted = false;

  const expectTriggerMode = async () => {
    expect(await readAttGenerated(object.schemaName, tableName)).toBe('');
    expect(await isTriggerMode(object.schemaName, tableName)).toBe(true);
  };

  beforeAll(async () => {
    await deleteLeftoverObjects();
    object = await createObject(OBJECT);
  });

  afterAll(async () => {
    if (!isDefined(object)) {
      return;
    }

    await deleteBackfillJobs([object.id]);

    if (!isObjectDeleted) {
      await deleteObject(object.id);
    }
  });

  it('starts generated, and is detected as trigger mode once converted by hand', async () => {
    expect(await readAttGenerated(object.schemaName, tableName)).toBe('s');
    expect(await isTriggerMode(object.schemaName, tableName)).toBe(false);

    await convertTableByHand(object.schemaName, tableName);

    await expectTriggerMode();
  });

  it('refreshes the trigger when a TEXT field becomes searchable', async () => {
    const codenameField = await createField({
      objectMetadataId: object.id,
      name: 'codename',
      type: FieldMetadataType.TEXT,
    });

    await makeLabelIdentifier(object.id, codenameField.id);

    await expectTriggerMode();
    expect(
      await readFunctionDefinition(object.schemaName, tableName),
    ).toContain('NEW."codename"');

    firstRecordId = await createRecord(OBJECT.nameSingular, {
      codename: 'zzcodenametoken',
    });

    expect(
      await vectorMatches(
        object.schemaName,
        tableName,
        firstRecordId,
        'zzcodenametoken',
      ),
    ).toBe(true);
    expect(await searchCount(OBJECT.nameSingular, 'zzcodenametoken')).toBe(1);
  });

  it('follows a field rename, so saves keep working', async () => {
    const [{ id: codenameFieldId }] = await query<{ id: string }>(
      `SELECT id FROM core."fieldMetadata" WHERE "objectMetadataId" = $1 AND name = 'codename'`,
      [object.id],
    );

    await updateOneFieldMetadata({
      expectToFail: false,
      gqlFields: `id`,
      input: {
        idToUpdate: codenameFieldId,
        updatePayload: { name: 'alias', label: 'alias' },
      },
    });

    await expectTriggerMode();
    const definition = await readFunctionDefinition(
      object.schemaName,
      tableName,
    );

    expect(definition).toContain('NEW."alias"');
    expect(definition).not.toContain('NEW."codename"');

    const secondRecordId = await createRecord(OBJECT.nameSingular, {
      alias: 'zzaliastoken',
    });

    await updateRecord(OBJECT.nameSingular, firstRecordId, {
      alias: 'zzupdatedtoken',
    });

    expect(
      await vectorMatches(
        object.schemaName,
        tableName,
        secondRecordId,
        'zzaliastoken',
      ),
    ).toBe(true);
    expect(await searchCount(OBJECT.nameSingular, 'zzupdatedtoken')).toBe(1);
  });

  it('survives relabelling and removing options of a searched dropdown', async () => {
    const tierField = await createField({
      objectMetadataId: object.id,
      name: 'tier',
      type: FieldMetadataType.SELECT,
      options: [
        { label: 'Gold', value: 'GOLD', position: 0, color: 'green' },
        { label: 'Silver', value: 'SILVER', position: 1, color: 'gray' },
        { label: 'Bronze', value: 'BRONZE', position: 2, color: 'orange' },
      ],
    });

    tierFieldId = tierField.id;
    tierOptionIds = Object.fromEntries(
      (tierField.options ?? []).flatMap((option) =>
        isDefined(option.id) ? [[option.value, option.id] as const] : [],
      ),
    );

    await registerSearchField({
      objectMetadataId: object.id,
      fieldMetadataId: tierFieldId,
      workspaceId: object.workspaceId,
    });

    await expectTriggerMode();
    expect(
      await readFunctionDefinition(object.schemaName, tableName),
    ).toContain("'BRONZE'");

    const goldRecordId = await createRecord(OBJECT.nameSingular, {
      tier: 'GOLD',
    });

    // Rows the enum swap rewrites, which fire the trigger unless it is disabled.
    await createRecord(OBJECT.nameSingular, { tier: 'BRONZE' });

    await updateOneFieldMetadata({
      expectToFail: false,
      gqlFields: `id`,
      input: {
        idToUpdate: tierFieldId,
        updatePayload: {
          options: [
            {
              id: tierOptionIds.GOLD,
              label: 'Platinum',
              value: 'GOLD',
              position: 0,
              color: 'green',
            },
            {
              id: tierOptionIds.SILVER,
              label: 'Silver',
              value: 'SILVER',
              position: 1,
              color: 'gray',
            },
          ],
        },
      },
    });

    await expectTriggerMode();
    const definition = await readFunctionDefinition(
      object.schemaName,
      tableName,
    );

    expect(definition).toContain('Platinum');
    expect(definition).not.toContain("'BRONZE'");

    await createRecord(OBJECT.nameSingular, { tier: 'SILVER' });
    await updateRecord(OBJECT.nameSingular, goldRecordId, { alias: 'zzgold' });

    expect(
      await vectorMatches(
        object.schemaName,
        tableName,
        goldRecordId,
        'platinum',
      ),
    ).toBe(true);
  });

  it('renames a searched field and changes another dropdown in one migration', async () => {
    const { findFieldByName } = await getObjectFlatEntities(
      object.id,
      object.workspaceId,
    );
    const aliasField = findFieldByName('alias');
    const tierField = findFieldByName('tier');

    await runLegacyMigration({
      workspaceId: object.workspaceId,
      applicationUniversalIdentifier: await getApplicationUniversalIdentifier(
        object.id,
      ),
      allFlatEntityOperationByMetadataName: {
        fieldMetadata: {
          flatEntityToCreate: [],
          flatEntityToDelete: [],
          flatEntityToUpdate: [
            { ...aliasField, name: 'moniker', label: 'moniker' },
            {
              ...tierField,
              options: [
                {
                  id: tierOptionIds.GOLD,
                  label: 'Platinum',
                  value: 'GOLD',
                  position: 0,
                  color: 'green',
                },
                {
                  id: crypto.randomUUID(),
                  label: 'Copper',
                  value: 'COPPER',
                  position: 1,
                  color: 'orange',
                },
              ],
            } as FlatFieldMetadata,
          ],
        },
      },
    });

    await expectTriggerMode();
    const definition = await readFunctionDefinition(
      object.schemaName,
      tableName,
    );

    expect(definition).toContain('NEW."moniker"');
    expect(definition).not.toContain('NEW."alias"');
    expect(definition).toContain("'COPPER'");
    expect(definition).not.toContain("'SILVER'");

    const recordId = await createRecord(OBJECT.nameSingular, {
      moniker: 'zzmonikertoken',
      tier: 'COPPER',
    });

    expect(
      await vectorMatches(object.schemaName, tableName, recordId, 'copper'),
    ).toBe(true);
    expect(await searchCount(OBJECT.nameSingular, 'zzmonikertoken')).toBe(1);
  });

  it('unmarks a dropdown from search and changes its options in one migration', async () => {
    const { findFieldByName, findSearchFieldsOf } = await getObjectFlatEntities(
      object.id,
      object.workspaceId,
    );
    const tierField = findFieldByName('tier');

    // Removing COPPER leaves a literal in the trigger that the new enum cannot cast.
    await runLegacyMigration({
      workspaceId: object.workspaceId,
      applicationUniversalIdentifier: await getApplicationUniversalIdentifier(
        object.id,
      ),
      allFlatEntityOperationByMetadataName: {
        searchFieldMetadata: {
          flatEntityToCreate: [],
          flatEntityToDelete: findSearchFieldsOf(tierField.id),
          flatEntityToUpdate: [],
        },
        fieldMetadata: {
          flatEntityToCreate: [],
          flatEntityToDelete: [],
          flatEntityToUpdate: [
            {
              ...tierField,
              options: [
                {
                  id: tierOptionIds.GOLD,
                  label: 'Platinum',
                  value: 'GOLD',
                  position: 0,
                  color: 'green',
                },
              ],
            } as FlatFieldMetadata,
          ],
        },
      },
    });

    await expectTriggerMode();
    expect(
      await readFunctionDefinition(object.schemaName, tableName),
    ).not.toContain('NEW."tier"');

    await createRecord(OBJECT.nameSingular, {
      moniker: 'zzunmarkedtoken',
      tier: 'GOLD',
    });
    expect(await searchCount(OBJECT.nameSingular, 'zzunmarkedtoken')).toBe(1);
  });

  it('drops a deleted field from the trigger', async () => {
    await deleteField(tierFieldId);

    await expectTriggerMode();
    expect(
      await readFunctionDefinition(object.schemaName, tableName),
    ).not.toContain('NEW."tier"');

    await createRecord(OBJECT.nameSingular, { moniker: 'zzafterdelete' });
  });

  it('carries the trigger over when the object is renamed', async () => {
    const previousTableName = tableName;

    await updateOneObjectMetadata({
      expectToFail: false,
      input: {
        idToUpdate: object.id,
        updatePayload: {
          ...RENAMED_OBJECT,
          labelSingular: RENAMED_OBJECT.nameSingular,
          labelPlural: RENAMED_OBJECT.namePlural,
        },
      },
    });
    tableName = tableNameOf(RENAMED_OBJECT.nameSingular);

    await expectTriggerMode();
    expect(
      await readFunctionDefinition(object.schemaName, previousTableName),
    ).toBeNull();

    const nicknameField = await createField({
      objectMetadataId: object.id,
      name: 'nickname',
      type: FieldMetadataType.TEXT,
    });

    await makeLabelIdentifier(object.id, nicknameField.id);

    await expectTriggerMode();
    expect(
      await readFunctionDefinition(object.schemaName, tableName),
    ).toContain('NEW."nickname"');

    const recordId = await createRecord(RENAMED_OBJECT.nameSingular, {
      nickname: 'zznicknametoken',
    });

    expect(
      await vectorMatches(
        object.schemaName,
        tableName,
        recordId,
        'zznicknametoken',
      ),
    ).toBe(true);
  });

  it('drops the trigger function with the object', async () => {
    await deleteObject(object.id);
    isObjectDeleted = true;

    expect(
      await readFunctionDefinition(object.schemaName, tableName),
    ).toBeNull();
  });
});

describe('searchVector generated mode across workspace migrations', () => {
  let object: CreatedObject;
  const tableName = tableNameOf(GENERATED_OBJECT.nameSingular);

  beforeAll(async () => {
    await deleteLeftoverObjects();
    object = await createObject(GENERATED_OBJECT);
  });

  afterAll(async () => {
    if (isDefined(object)) {
      await deleteBackfillJobs([object.id]);
      await deleteObject(object.id);
    }
  });

  it('keeps a non-converted table generated through a searched field rename', async () => {
    const codenameField = await createField({
      objectMetadataId: object.id,
      name: 'codename',
      type: FieldMetadataType.TEXT,
    });

    await makeLabelIdentifier(object.id, codenameField.id);
    await updateOneFieldMetadata({
      expectToFail: false,
      gqlFields: `id`,
      input: {
        idToUpdate: codenameField.id,
        updatePayload: { name: 'alias', label: 'alias' },
      },
    });

    expect(await readAttGenerated(object.schemaName, tableName)).toBe('s');
    expect(
      await readFunctionDefinition(object.schemaName, tableName),
    ).toBeNull();

    const recordId = await createRecord(GENERATED_OBJECT.nameSingular, {
      alias: 'zzgeneratedtoken',
    });

    expect(
      await vectorMatches(
        object.schemaName,
        tableName,
        recordId,
        'zzgeneratedtoken',
      ),
    ).toBe(true);
  });
});

const readBackfillJobs = (objectMetadataId: string) =>
  query<{
    reason: string;
    status: string;
    filter: { fieldMetadataId: string; optionValues?: string[] } | null;
    processedRowCount: number;
  }>(
    `SELECT "reason", "status", "filter", "processedRowCount"
       FROM core."searchVectorBackfillJob" WHERE "objectMetadataId" = $1
      ORDER BY "createdAt"`,
    [objectMetadataId],
  );

const readLatestBackfillJob = async (objectMetadataId: string) => {
  const jobs = await readBackfillJobs(objectMetadataId);

  return jobs[jobs.length - 1];
};

// Calls the service the crons drive, so the test does not wait a minute for a claim.
const runBackfillJobs = async () => {
  const searchVectorBackfillService =
    getAppProviderByClassName<SearchVectorBackfillService>(
      'SearchVectorBackfillService',
    );

  // Only one job runs per workspace at a time, so keep claiming until none are left.
  for (
    let claimedJobs = await searchVectorBackfillService.claimRunnableJobs();
    claimedJobs.length > 0;
    claimedJobs = await searchVectorBackfillService.claimRunnableJobs()
  ) {
    for (const claimedJob of claimedJobs) {
      while (!(await searchVectorBackfillService.runBatch(claimedJob))) {
        // one batch per call, as the queue does
      }
    }
  }
};

describe('searchVector trigger mode backfill jobs', () => {
  let object: CreatedObject;
  const tableName = tableNameOf(BACKFILL_OBJECT.nameSingular);
  let tierFieldId: string;
  let goldRecordIds: string[] = [];

  beforeAll(async () => {
    await deleteLeftoverObjects();
    object = await createObject(BACKFILL_OBJECT);
    await convertTableByHand(object.schemaName, tableName);

    const tierField = await createField({
      objectMetadataId: object.id,
      name: 'tier',
      type: FieldMetadataType.SELECT,
      options: [
        { label: 'Gilded', value: 'GOLD', position: 0, color: 'green' },
        { label: 'Silver', value: 'SILVER', position: 1, color: 'gray' },
      ],
    });

    tierFieldId = tierField.id;
    await registerSearchField({
      objectMetadataId: object.id,
      fieldMetadataId: tierFieldId,
      workspaceId: object.workspaceId,
    });
    await runBackfillJobs();

    goldRecordIds = [
      await createRecord(BACKFILL_OBJECT.nameSingular, { tier: 'GOLD' }),
      await createRecord(BACKFILL_OBJECT.nameSingular, { tier: 'GOLD' }),
    ];
    await createRecord(BACKFILL_OBJECT.nameSingular, { tier: 'SILVER' });
  });

  afterAll(async () => {
    if (isDefined(object)) {
      await deleteBackfillJobs([object.id]);
      await deleteObject(object.id);
    }
  });

  it('backfills only the rows holding a relabelled option, without touching updatedAt', async () => {
    const [tierField] = await query<{
      options: Array<{ id: string; value: string }>;
    }>(`SELECT options FROM core."fieldMetadata" WHERE id = $1`, [tierFieldId]);
    const optionIdByValue = Object.fromEntries(
      tierField.options.map((option) => [option.value, option.id]),
    );
    const readUpdatedAt = () =>
      query<{ updatedAt: Date }>(
        `SELECT "updatedAt" FROM "${object.schemaName}"."${tableName}" WHERE id = ANY($1) ORDER BY id`,
        [goldRecordIds],
      );
    const updatedAtBefore = await readUpdatedAt();

    await updateOneFieldMetadata({
      expectToFail: false,
      gqlFields: `id`,
      input: {
        idToUpdate: tierFieldId,
        updatePayload: {
          options: [
            {
              id: optionIdByValue.GOLD,
              label: 'Platinum',
              value: 'GOLD',
              position: 0,
              color: 'green',
            },
            {
              id: optionIdByValue.SILVER,
              label: 'Silver',
              value: 'SILVER',
              position: 1,
              color: 'gray',
            },
          ],
        },
      },
    });

    expect(await readLatestBackfillJob(object.id)).toMatchObject({
      reason: 'OPTION_CHANGE',
      status: 'PENDING',
      filter: { fieldMetadataId: tierFieldId, optionValues: ['GOLD'] },
    });
    // No "before" search check: installing the trigger re-saves one row as a runtime check.
    await runBackfillJobs();

    expect(await readLatestBackfillJob(object.id)).toMatchObject({
      status: 'COMPLETED',
      processedRowCount: 2,
    });
    expect(await searchCount(BACKFILL_OBJECT.nameSingular, 'platinum')).toBe(2);
    expect(await searchCount(BACKFILL_OBJECT.nameSingular, 'gilded')).toBe(0);
    expect(await readUpdatedAt()).toEqual(updatedAtBefore);
  });

  it('creates no job for a new searchable field that is empty on every row', async () => {
    const jobCountBefore = (await readBackfillJobs(object.id)).length;
    const [identifiers] = await query<{
      objectUniversalIdentifier: string;
      applicationUniversalIdentifier: string;
      tsVectorUniversalIdentifier: string;
    }>(
      `SELECT o."universalIdentifier" AS "objectUniversalIdentifier",
              a."universalIdentifier" AS "applicationUniversalIdentifier",
              v."universalIdentifier" AS "tsVectorUniversalIdentifier"
         FROM core."objectMetadata" o
         JOIN core."application" a ON a.id = o."applicationId"
         JOIN core."fieldMetadata" v ON v."objectMetadataId" = o.id AND v.name = 'searchVector'
        WHERE o.id = $1`,
      [object.id],
    );
    const freshFlatFieldMetadata = getDefaultFlatFieldMetadata({
      createFieldInput: {
        name: 'freshText',
        label: 'freshText',
        type: FieldMetadataType.TEXT,
      },
      applicationUniversalIdentifier:
        identifiers.applicationUniversalIdentifier,
      objectMetadataUniversalIdentifier: identifiers.objectUniversalIdentifier,
    });

    await runLegacyMigration({
      workspaceId: object.workspaceId,
      applicationUniversalIdentifier:
        identifiers.applicationUniversalIdentifier,
      allFlatEntityOperationByMetadataName: {
        fieldMetadata: {
          flatEntityToCreate: [freshFlatFieldMetadata],
          flatEntityToDelete: [],
          flatEntityToUpdate: [],
        },
        searchFieldMetadata: {
          flatEntityToCreate: [
            buildFlatSearchFieldMetadataForField({
              flatObjectMetadata: {
                universalIdentifier: identifiers.objectUniversalIdentifier,
                applicationUniversalIdentifier:
                  identifiers.applicationUniversalIdentifier,
              },
              flatFieldMetadata: {
                universalIdentifier: freshFlatFieldMetadata.universalIdentifier,
              },
              tsVectorFlatFieldMetadata: {
                universalIdentifier: identifiers.tsVectorUniversalIdentifier,
              },
              position: 20,
            }),
          ],
          flatEntityToDelete: [],
          flatEntityToUpdate: [],
        },
      },
    });

    expect(
      await readFunctionDefinition(object.schemaName, tableName),
    ).toContain('NEW."freshText"');
    expect(await readBackfillJobs(object.id)).toHaveLength(jobCountBefore);
  });

  it('backfills the whole table when a searched field is deleted', async () => {
    await deleteField(tierFieldId);

    expect(await readLatestBackfillJob(object.id)).toMatchObject({
      reason: 'FIELD_DELETE',
      status: 'PENDING',
      filter: null,
    });

    await runBackfillJobs();

    expect(await readLatestBackfillJob(object.id)).toMatchObject({
      status: 'COMPLETED',
      processedRowCount: 3,
    });
    expect(
      await vectorMatches(
        object.schemaName,
        tableName,
        goldRecordIds[0],
        'platinum',
      ),
    ).toBe(false);
  });
});

const getConversionService = () =>
  getAppProviderByClassName<SearchVectorTriggerConversionService>(
    'SearchVectorTriggerConversionService',
  );

// Only ever this suite's table: the seeded tables of the shared test workspace stay generated.
const findOwnTablePlan = async (workspaceId: string, tableName: string) => {
  const { plans } = await getConversionService().buildWorkspaceTablePlans(
    workspaceId,
    { refreshCache: true },
  );
  const plan = plans.find((tablePlan) => tablePlan.tableName === tableName);

  if (!isDefined(plan)) {
    throw new Error(`No conversion plan for ${tableName}`);
  }

  return plan;
};

// A searchable label identifier, so the object has something to search and gets a plan.
const createSearchableObject = async (names: {
  nameSingular: string;
  namePlural: string;
}) => {
  const createdObject = await createObject(names);
  const codenameField = await createField({
    objectMetadataId: createdObject.id,
    name: 'codename',
    type: FieldMetadataType.TEXT,
  });

  await makeLabelIdentifier(createdObject.id, codenameField.id);

  return createdObject;
};

describe('searchVector conversion with --repair', () => {
  let object: CreatedObject;
  const tableName = tableNameOf(REPAIR_OBJECT.nameSingular);
  let recordId: string;

  beforeAll(async () => {
    await deleteLeftoverObjects();
    object = await createSearchableObject(REPAIR_OBJECT);
    recordId = await createRecord(REPAIR_OBJECT.nameSingular, {
      codename: 'zzrepairtoken',
    });

    // The July/August batch-create bug: a plain column nothing fills, NULL on every row.
    await query(
      `ALTER TABLE "${object.schemaName}"."${tableName}" ALTER COLUMN "searchVector" DROP EXPRESSION`,
    );
    await query(
      `UPDATE "${object.schemaName}"."${tableName}" SET "searchVector" = NULL`,
    );
  });

  afterAll(async () => {
    if (isDefined(object)) {
      await deleteBackfillJobs([object.id]);
      await deleteObject(object.id);
    }
  });

  it('refuses the broken table without --repair', async () => {
    const plan = await findOwnTablePlan(object.workspaceId, tableName);

    await expect(
      getConversionService().convertTable({ ...plan, dryRun: false }),
    ).resolves.toEqual({ status: 'mismatch', mismatchCount: 1 });
    expect(await isTriggerMode(object.schemaName, tableName)).toBe(false);
  });

  it('reports what a repair would do on a dry run, changing nothing', async () => {
    const plan = await findOwnTablePlan(object.workspaceId, tableName);
    const repair = {
      workspaceId: object.workspaceId,
      objectMetadataId: object.id,
    };

    await expect(
      getConversionService().convertTable({ ...plan, dryRun: true, repair }),
    ).resolves.toEqual({ status: 'needsRepair', mismatchCount: 1 });
    expect(await isTriggerMode(object.schemaName, tableName)).toBe(false);
    expect(await readBackfillJobs(object.id)).toHaveLength(0);
  });

  it('installs the trigger and queues a whole-table REPAIR backfill', async () => {
    const plan = await findOwnTablePlan(object.workspaceId, tableName);

    await expect(
      getConversionService().convertTable({
        ...plan,
        dryRun: false,
        repair: {
          workspaceId: object.workspaceId,
          objectMetadataId: object.id,
        },
      }),
    ).resolves.toEqual({ status: 'repaired', mismatchCount: 1 });

    expect(await isTriggerMode(object.schemaName, tableName)).toBe(true);
    expect(await readLatestBackfillJob(object.id)).toMatchObject({
      reason: 'REPAIR',
      status: 'PENDING',
      filter: null,
    });

    await runBackfillJobs();

    expect(await readLatestBackfillJob(object.id)).toMatchObject({
      status: 'COMPLETED',
    });
    expect(
      await vectorMatches(
        object.schemaName,
        tableName,
        recordId,
        'zzrepairtoken',
      ),
    ).toBe(true);
  });
});

describe('searchVector conversion of a workspace', () => {
  let convertedObject: CreatedObject | undefined;
  let selfHealObject: CreatedObject | undefined;
  let newObject: CreatedObject | undefined;
  let workspaceId: string;
  const convertedTableName = tableNameOf(REPAIR_OBJECT.nameSingular);
  const selfHealTableName = tableNameOf(SELF_HEAL_OBJECT.nameSingular);
  const newTableName = tableNameOf(CONVERTED_WORKSPACE_OBJECT.nameSingular);

  const readFlag = async () => {
    const rows = await query<{ value: boolean }>(
      `SELECT "value" FROM core."featureFlag" WHERE "workspaceId" = $1 AND "key" = 'IS_SEARCH_VECTOR_TRIGGER_ENABLED'`,
      [workspaceId],
    );

    return rows[0]?.value;
  };

  beforeAll(async () => {
    await deleteLeftoverObjects();
    convertedObject = await createSearchableObject(REPAIR_OBJECT);
    // Created before the flag, and left out of the conversion below, so it stays generated.
    selfHealObject = await createObject(SELF_HEAL_OBJECT);
    workspaceId = convertedObject.workspaceId;
  });

  afterAll(async () => {
    jest.restoreAllMocks();

    const createdObjects = [newObject, selfHealObject, convertedObject].filter(
      isDefined,
    );

    await deleteBackfillJobs(
      createdObjects.map((createdObject) => createdObject.id),
    );

    for (const createdObject of createdObjects) {
      await deleteObject(createdObject.id);
    }

    if (isDefined(workspaceId)) {
      await query(
        `DELETE FROM core."featureFlag" WHERE "workspaceId" = $1 AND "key" = 'IS_SEARCH_VECTOR_TRIGGER_ENABLED'`,
        [workspaceId],
      );
      await getAppProviderByClassName<WorkspaceCacheService>(
        'WorkspaceCacheService',
      ).invalidateAndRecompute(workspaceId, ['featureFlagsMap']);
    }
  });

  it('converts nothing and asks for a rerun when a search list changes before the lock', async () => {
    const conversionService = getConversionService();
    const ownPlan = await findOwnTablePlan(workspaceId, convertedTableName);

    // The second build is the one under the lock: it sees a different formula.
    jest
      .spyOn(conversionService, 'buildWorkspaceTablePlans')
      .mockResolvedValueOnce({ plans: [ownPlan], unplannedTables: [] })
      .mockResolvedValueOnce({
        plans: [
          { ...ownPlan, triggerRowExpression: `to_tsvector('simple', NULL)` },
        ],
        unplannedTables: [],
      });

    const report = await conversionService.convertWorkspace({
      workspaceId,
      dryRun: false,
    });

    expect(report.status).toBe('changed');
    expect(
      await readAttGenerated(
        getWorkspaceSchemaName(workspaceId),
        convertedTableName,
      ),
    ).toBe('s');
    expect(await readFlag()).toBeUndefined();

    jest.restoreAllMocks();
  });

  it('converts under the workspace lock, backfills rows the switch missed, and sets the flag', async () => {
    const conversionService = getConversionService();
    const ownPlan = await findOwnTablePlan(workspaceId, convertedTableName);
    const schemaName = getWorkspaceSchemaName(workspaceId);
    const recordId = await createRecord(REPAIR_OBJECT.nameSingular, {
      codename: 'zzswitchtoken',
    });
    const switchTable = conversionService.switchTable.bind(conversionService);

    // Limits the run to this suite's table, so the seeded tables are never converted.
    jest
      .spyOn(conversionService, 'buildWorkspaceTablePlans')
      .mockResolvedValue({ plans: [ownPlan], unplannedTables: [] });
    // Stands in for a row the switch missed, so the verify scan has one to find.
    jest
      .spyOn(conversionService, 'switchTable')
      .mockImplementation(async (args) => {
        const switched = await switchTable(args);

        await query(
          `ALTER TABLE "${schemaName}"."${convertedTableName}" DISABLE TRIGGER USER`,
        );
        await query(
          `UPDATE "${schemaName}"."${convertedTableName}" SET "searchVector" = NULL WHERE id = $1`,
          [recordId],
        );
        await query(
          `ALTER TABLE "${schemaName}"."${convertedTableName}" ENABLE TRIGGER USER`,
        );

        return switched;
      });

    expect(await readFlag()).toBeUndefined();

    const report = await conversionService.convertWorkspace({
      workspaceId,
      dryRun: false,
    });

    expect(report).toEqual({
      status: 'converted',
      tables: [
        {
          tableName: convertedTableName,
          status: 'repaired',
          mismatchCount: 1,
          note: expect.any(String),
        },
      ],
    });
    expect(await isTriggerMode(schemaName, convertedTableName)).toBe(true);
    expect(await readFlag()).toBe(true);
    expect(await readLatestBackfillJob(ownPlan.objectMetadataId)).toMatchObject(
      { reason: 'REPAIR', status: 'PENDING', filter: null },
    );

    jest.restoreAllMocks();
    await runBackfillJobs();

    expect(
      await vectorMatches(
        schemaName,
        convertedTableName,
        recordId,
        'zzswitchtoken',
      ),
    ).toBe(true);
  });

  it('creates new objects in trigger mode once the flag is on', async () => {
    newObject = await createObject(CONVERTED_WORKSPACE_OBJECT);

    // The create-time install, before any field change refreshes the function.
    expect(await isTriggerMode(newObject.schemaName, newTableName)).toBe(true);
    expect(
      await readFunctionDefinition(newObject.schemaName, newTableName),
    ).toContain('NEW."name"');

    const codenameField = await createField({
      objectMetadataId: newObject.id,
      name: 'codename',
      type: FieldMetadataType.TEXT,
    });

    await makeLabelIdentifier(newObject.id, codenameField.id);

    expect(await readAttGenerated(newObject.schemaName, newTableName)).toBe('');
    expect(await isTriggerMode(newObject.schemaName, newTableName)).toBe(true);
    expect(
      await readFunctionDefinition(newObject.schemaName, newTableName),
    ).toContain('NEW."codename"');

    const recordId = await createRecord(
      CONVERTED_WORKSPACE_OBJECT.nameSingular,
      {
        codename: 'zznewobjecttoken',
      },
    );

    expect(
      await vectorMatches(
        newObject.schemaName,
        newTableName,
        recordId,
        'zznewobjecttoken',
      ),
    ).toBe(true);
  });

  it('switches a still-generated table in place on its next search list change', async () => {
    if (!isDefined(selfHealObject)) {
      throw new Error('Self-heal object was not created');
    }

    const { schemaName } = selfHealObject;

    expect(await readAttGenerated(schemaName, selfHealTableName)).toBe('s');

    const codenameField = await createField({
      objectMetadataId: selfHealObject.id,
      name: 'codename',
      type: FieldMetadataType.TEXT,
    });
    const recordIds = [
      await createRecord(SELF_HEAL_OBJECT.nameSingular, {
        codename: 'zzselfhealtoken',
      }),
      await createRecord(SELF_HEAL_OBJECT.nameSingular, {
        codename: 'zzselfhealtoken',
      }),
    ];
    const countMatchingRecords = async () => {
      let matchingRecordCount = 0;

      for (const recordId of recordIds) {
        if (
          await vectorMatches(
            schemaName,
            selfHealTableName,
            recordId,
            'zzselfhealtoken',
          )
        ) {
          matchingRecordCount += 1;
        }
      }

      return matchingRecordCount;
    };

    await makeLabelIdentifier(selfHealObject.id, codenameField.id);

    expect(await readAttGenerated(schemaName, selfHealTableName)).toBe('');
    expect(await isTriggerMode(schemaName, selfHealTableName)).toBe(true);
    expect(
      await readFunctionDefinition(schemaName, selfHealTableName),
    ).toContain('NEW."codename"');
    expect(await readLatestBackfillJob(selfHealObject.id)).toMatchObject({
      reason: 'REPAIR',
      status: 'PENDING',
      filter: null,
    });

    // The trigger's runtime check re-saves one row; the other waits for the backfill.
    expect(await countMatchingRecords()).toBeLessThan(2);

    await runBackfillJobs();

    expect(await countMatchingRecords()).toBe(2);
  });
});
