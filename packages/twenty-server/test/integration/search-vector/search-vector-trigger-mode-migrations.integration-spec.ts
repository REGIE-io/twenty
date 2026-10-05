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
import { isSearchVectorTriggerMode } from 'src/engine/core-modules/search-vector-trigger/utils/search-vector-trigger-maintenance.util';
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

type CreatedObject = { id: string; workspaceId: string; schemaName: string };

const tableNameOf = (nameSingular: string) => `_${nameSingular}`;

const query = <TRow>(sql: string, parameters?: unknown[]): Promise<TRow[]> =>
  global.testDataSource.query(sql, parameters);

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
    if (!isObjectDeleted && isDefined(object)) {
      await deleteObject(object.id);
    }
  });

  it('starts generated, and is detected as trigger mode once converted by hand', async () => {
    expect(await readAttGenerated(object.schemaName, tableName)).toBe('s');
    expect(await isTriggerMode(object.schemaName, tableName)).toBe(false);

    // A placeholder formula: the runner has to replace it with the real one.
    const statements = buildSearchVectorTriggerStatements({
      schemaName: object.schemaName,
      tableName,
      triggerRowExpression: `to_tsvector('simple', NULL)`,
    });

    await query(
      `ALTER TABLE "${object.schemaName}"."${tableName}" ALTER COLUMN "searchVector" DROP EXPRESSION`,
    );
    await query(statements.createFunction);
    await query(statements.dropTrigger);
    await query(statements.createTrigger);

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
