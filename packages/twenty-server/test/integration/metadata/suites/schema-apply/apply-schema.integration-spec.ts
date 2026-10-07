import { updateOneFieldMetadata } from 'test/integration/metadata/suites/field-metadata/utils/update-one-field-metadata.util';
import { deleteOneObjectMetadata } from 'test/integration/metadata/suites/object-metadata/utils/delete-one-object-metadata.util';
import { updateOneObjectMetadata } from 'test/integration/metadata/suites/object-metadata/utils/update-one-object-metadata.util';
import { makeRestAPIRequest } from 'test/integration/rest/utils/make-rest-api-request.util';
import { FieldMetadataType } from 'twenty-shared/types';

import { SEED_APPLE_WORKSPACE_ID } from 'src/engine/workspace-manager/dev-seeder/core/constants/seeder-workspaces.constant';

// crm provisions its whole schema through this endpoint, so a fresh apply must cost a
// single workspace migration and a repeated apply none at all.
const TEST_SCHEMA_NAME = 'workspace_1wgvd1injqtife6y4rvfbu3h5';

const SCHEMA = {
  objects: [
    {
      nameSingular: 'schemaApplyList',
      namePlural: 'schemaApplyLists',
      labelSingular: 'Schema Apply List',
      labelPlural: 'Schema Apply Lists',
      icon: 'IconList',
    },
    {
      nameSingular: 'schemaApplyMembership',
      namePlural: 'schemaApplyMemberships',
      labelSingular: 'Schema Apply Membership',
      labelPlural: 'Schema Apply Memberships',
    },
  ],
  fields: [
    {
      objectNameSingular: 'schemaApplyList',
      name: 'name',
      label: 'Name',
      type: FieldMetadataType.TEXT,
    },
    {
      objectNameSingular: 'schemaApplyList',
      name: 'status',
      label: 'Status',
      type: FieldMetadataType.SELECT,
      options: [
        { value: 'READY', label: 'READY', color: 'gray', position: 0 },
        { value: 'FAILED', label: 'FAILED', color: 'gray', position: 1 },
      ],
    },
    {
      objectNameSingular: 'schemaApplyMembership',
      name: 'membershipKey',
      label: 'Membership Key',
      type: FieldMetadataType.TEXT,
    },
    {
      objectNameSingular: 'schemaApplyMembership',
      name: 'list',
      label: 'List',
      type: FieldMetadataType.RELATION,
      relation: {
        type: 'MANY_TO_ONE',
        targetObjectNameSingular: 'schemaApplyList',
        targetFieldName: 'members',
        targetFieldLabel: 'Members',
        targetFieldIcon: 'IconList',
        onDelete: 'CASCADE',
      },
    },
    {
      objectNameSingular: 'schemaApplyMembership',
      name: 'person',
      label: 'Person',
      type: FieldMetadataType.RELATION,
      relation: {
        type: 'MANY_TO_ONE',
        targetObjectNameSingular: 'person',
        targetFieldName: 'schemaApplyMemberships',
        targetFieldLabel: 'Schema Apply Memberships',
        targetFieldIcon: 'IconList',
        onDelete: 'CASCADE',
      },
    },
  ],
  fieldSettings: [
    {
      objectNameSingular: 'person',
      name: 'jobTitle',
      settings: { displayedMaxRows: 3 },
    },
  ],
  indexes: [
    {
      objectNameSingular: 'schemaApplyMembership',
      fieldNames: ['membershipKey'],
      isUnique: true,
    },
    {
      objectNameSingular: 'schemaApplyMembership',
      fieldNames: ['list'],
      isUnique: false,
    },
  ],
  views: [
    {
      objectNameSingular: 'schemaApplyList',
      name: 'All Schema Apply Lists',
      icon: 'IconList',
      type: 'TABLE',
    },
    {
      objectNameSingular: 'schemaApplyList',
      name: 'Ready Lists',
      icon: 'IconList',
      type: 'TABLE',
    },
    {
      objectNameSingular: 'person',
      name: 'all people',
      icon: 'IconUser',
      type: 'TABLE',
    },
  ],
};

type ApplyResultItem = { id: string; created?: boolean; updated?: boolean };

const readMetadataVersion = async (): Promise<number> => {
  const [workspace]: { metadataVersion: number }[] =
    await global.testDataSource.query(
      `SELECT "metadataVersion" FROM core.workspace WHERE id = $1`,
      [SEED_APPLE_WORKSPACE_ID],
    );

  return workspace.metadataVersion;
};

const readJobTitleField = async (): Promise<{
  id: string;
  settings: Record<string, unknown> | null;
}> => {
  const [field]: { id: string; settings: Record<string, unknown> | null }[] =
    await global.testDataSource.query(
      `SELECT field.id, field.settings FROM core."fieldMetadata" field
       JOIN core."objectMetadata" object ON object.id = field."objectMetadataId"
       WHERE field."workspaceId" = $1 AND object."nameSingular" = 'person'
       AND field.name = 'jobTitle'`,
      [SEED_APPLE_WORKSPACE_ID],
    );

  return field;
};

const findSchemaApplyObjectIds = async (): Promise<string[]> => {
  const rows: { id: string }[] = await global.testDataSource.query(
    `SELECT id FROM core."objectMetadata" WHERE "workspaceId" = $1 AND "nameSingular" = ANY($2)`,
    [
      SEED_APPLE_WORKSPACE_ID,
      SCHEMA.objects.map(({ nameSingular }) => nameSingular),
    ],
  );

  return rows.map(({ id }) => id);
};

const applySchema = () =>
  makeRestAPIRequest({
    method: 'post',
    path: '/metadata/schema/apply',
    body: SCHEMA,
  });

const createdFlags = (items: ApplyResultItem[]) =>
  items.map(({ created }) => created);

describe('Schema apply', () => {
  let originalJobTitleSettings: Record<string, unknown> | null;

  beforeAll(async () => {
    originalJobTitleSettings = (await readJobTitleField()).settings;
  });

  afterAll(async () => {
    // Membership references list, so it goes first.
    for (const id of (await findSchemaApplyObjectIds()).reverse()) {
      await updateOneObjectMetadata({
        expectToFail: false,
        input: { idToUpdate: id, updatePayload: { isActive: false } },
      });
      await deleteOneObjectMetadata({
        expectToFail: false,
        input: { idToDelete: id },
      });
    }

    await updateOneFieldMetadata({
      expectToFail: false,
      gqlFields: `id`,
      input: {
        idToUpdate: (await readJobTitleField()).id,
        updatePayload: { settings: originalJobTitleSettings },
      },
    });
  });

  it('applies a fresh schema in one migration and a repeated one in none', async () => {
    const metadataVersionBefore = await readMetadataVersion();

    const firstResponse = await applySchema();

    expect(firstResponse.status).toBe(200);

    const first = firstResponse.body.data;

    expect(await readMetadataVersion()).toBe(metadataVersionBefore + 1);
    expect(createdFlags(first.objects)).toEqual([true, true]);
    expect(createdFlags(first.fields)).toEqual([false, true, true, true, true]);
    expect(first.fieldSettings).toEqual([
      { objectNameSingular: 'person', name: 'jobTitle', updated: true },
    ]);
    expect(createdFlags(first.indexes)).toEqual([true, false]);
    expect(createdFlags(first.views)).toEqual([false, true, false]);
    expect((await readJobTitleField()).settings).toMatchObject({
      displayedMaxRows: 3,
    });

    const tables: { tablename: string }[] = await global.testDataSource.query(
      `SELECT tablename FROM pg_tables WHERE schemaname = $1 AND tablename = ANY($2) ORDER BY tablename`,
      [TEST_SCHEMA_NAME, ['_schemaApplyList', '_schemaApplyMembership']],
    );

    expect(tables.map(({ tablename }) => tablename)).toEqual([
      '_schemaApplyList',
      '_schemaApplyMembership',
    ]);

    // Same side effects as objects/batch and fields/batch-apply: menu items for the
    // objects, and index-view fields for every caller field, inverses included.
    const objectIds = first.objects.map(({ id }: ApplyResultItem) => id);
    const [{ count: navigationMenuItemCount }]: { count: number }[] =
      await global.testDataSource.query(
        `SELECT count(*)::int AS count FROM core."navigationMenuItem" WHERE "targetObjectMetadataId" = ANY($1)`,
        [objectIds],
      );
    const [{ count: commandMenuItemCount }]: { count: number }[] =
      await global.testDataSource.query(
        `SELECT count(*)::int AS count FROM core."commandMenuItem" WHERE payload->>'objectMetadataItemId' = ANY($1::text[])`,
        [objectIds],
      );
    const indexViewFieldNames: { name: string }[] =
      await global.testDataSource.query(
        `SELECT field.name FROM core."viewField" view_field
         JOIN core.view view ON view.id = view_field."viewId"
         JOIN core."fieldMetadata" field ON field.id = view_field."fieldMetadataId"
         JOIN core."objectMetadata" object ON object.id = view."objectMetadataId"
         WHERE view.key = 'INDEX' AND view."deletedAt" IS NULL
         AND object."workspaceId" = $1 AND object."nameSingular" = ANY($2)
         AND field.name = ANY($3)`,
        [
          SEED_APPLE_WORKSPACE_ID,
          ['schemaApplyList', 'schemaApplyMembership', 'person'],
          [
            'status',
            'membershipKey',
            'list',
            'members',
            'schemaApplyMemberships',
          ],
        ],
      );

    expect(navigationMenuItemCount).toBe(2);
    expect(commandMenuItemCount).toBe(2);
    expect(indexViewFieldNames.map(({ name }) => name).sort()).toEqual([
      'list',
      'members',
      'membershipKey',
      'schemaApplyMemberships',
      'status',
    ]);

    const secondResponse = await applySchema();

    expect(secondResponse.status).toBe(200);

    const second = secondResponse.body.data;

    expect(await readMetadataVersion()).toBe(metadataVersionBefore + 1);
    expect(
      [
        ...second.objects,
        ...second.fields,
        ...second.indexes,
        ...second.views,
      ].every(({ created }: ApplyResultItem) => created === false),
    ).toBe(true);
    expect(second.fieldSettings[0].updated).toBe(false);
    expect(second).toEqual({
      ...first,
      objects: first.objects.map((item: ApplyResultItem) => ({
        ...item,
        created: false,
      })),
      fields: first.fields.map((item: ApplyResultItem) => ({
        ...item,
        created: false,
      })),
      fieldSettings: first.fieldSettings.map((item: ApplyResultItem) => ({
        ...item,
        updated: false,
      })),
      indexes: first.indexes.map((item: ApplyResultItem) => ({
        ...item,
        created: false,
      })),
      views: first.views.map((item: ApplyResultItem) => ({
        ...item,
        created: false,
      })),
    });
  });

  it('rejects a field whose type differs from the existing one', async () => {
    const response = await makeRestAPIRequest({
      method: 'post',
      path: '/metadata/schema/apply',
      body: {
        fields: [
          {
            objectNameSingular: 'person',
            name: 'jobTitle',
            label: 'Job Title',
            type: FieldMetadataType.NUMBER,
          },
        ],
      },
    });

    expect(response.status).toBe(409);
    expect(JSON.stringify(response.body)).toContain('person.jobTitle');
  });
});
