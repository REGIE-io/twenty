import crypto from 'crypto';

import request from 'supertest';
import { FieldMetadataType } from 'twenty-shared/types';

import { type TwentyConfigService } from 'src/engine/core-modules/twenty-config/twenty-config.service';

import { makeRestAPIRequest } from 'test/integration/rest/utils/make-rest-api-request.util';
import crmSchemaApplyRequest from 'test/integration/workspace-provisioning/fixtures/crm-schema-apply-request.json';
import { getAppProviderByClassName } from 'test/integration/utils/get-app-provider-by-class-name.util';

jest.useRealTimers();
jest.setTimeout(120_000);

const INTERNAL_TOKEN = 'workspace-provisioning-api-key-integration-token';

const SCHEMA = {
  objects: [
    {
      nameSingular: 'provisionedList',
      namePlural: 'provisionedLists',
      labelSingular: 'Provisioned List',
      labelPlural: 'Provisioned Lists',
    },
  ],
  fields: [
    {
      objectNameSingular: 'provisionedList',
      name: 'listKey',
      label: 'List Key',
      type: FieldMetadataType.TEXT,
    },
  ],
  indexes: [
    {
      objectNameSingular: 'provisionedList',
      fieldNames: ['listKey'],
      isUnique: true,
    },
  ],
};

const postInternal = (path: string, body: object) =>
  request(global.app.getHttpServer())
    .post(path)
    .set('x-internal-token', INTERNAL_TOKEN)
    .send(body);

const uniqueSlug = (prefix: string) =>
  `${prefix}-${crypto.randomUUID().slice(0, 8)}`;

type ApplyResultEntry = { created?: boolean; updated?: boolean };

const readMetadataVersion = async (workspaceId: string): Promise<number> => {
  const [workspace]: { metadataVersion: number }[] =
    await global.testDataSource.query(
      'SELECT "metadataVersion" FROM core.workspace WHERE id = $1',
      [workspaceId],
    );

  return workspace.metadataVersion;
};

// crm creates the workspace with its API key, records its checkpoint, then applies the
// schema with that key, so a failed apply never orphans a workspace it cannot find again.
describe('internal workspace provisioning with an API key', () => {
  let configGetSpy: jest.SpyInstance;
  const workspaceIds: string[] = [];

  beforeAll(() => {
    const config = getAppProviderByClassName<TwentyConfigService>(
      'TwentyConfigService',
    );
    const originalGet = config.get.bind(config);

    configGetSpy = jest
      .spyOn(config, 'get')
      .mockImplementation(((key: Parameters<TwentyConfigService['get']>[0]) =>
        key === 'TWENTY_INTERNAL_METADATA_TOKEN'
          ? INTERNAL_TOKEN
          : originalGet(key)) as TwentyConfigService['get']);
  });

  afterAll(async () => {
    // Not through the internal DELETE route: it also soft-deletes the shared
    // provisioning user once that user has no other workspace.
    await global.testDataSource.query(
      'DELETE FROM core.workspace WHERE id = ANY($1::uuid[])',
      [workspaceIds],
    );
    configGetSpy.mockRestore();
  });

  it('returns an API key that can apply the schema to the new workspace', async () => {
    const slug = uniqueSlug('keyed-provisioning');

    const createResponse = await postInternal('/internal/workspaces', {
      name: 'API Key Provisioning',
      slug,
      apiKeyName: 'regie-crm-api',
    });

    expect(createResponse.status).toBe(200);
    workspaceIds.push(createResponse.body.workspaceId);

    const { apiKey } = createResponse.body;

    expect(createResponse.body).toMatchObject({
      ok: true,
      workspaceId: createResponse.body.id,
      workspaceSubdomain: slug,
    });
    expect(apiKey).toEqual({
      ok: true,
      workspaceId: createResponse.body.id,
      apiKey: expect.any(String),
      apiKeyId: expect.any(String),
    });

    const applyResponse = await makeRestAPIRequest({
      method: 'post',
      path: '/metadata/schema/apply',
      bearer: apiKey.apiKey,
      body: SCHEMA,
    });

    expect(applyResponse.status).toBe(200);
    expect(applyResponse.body.data.objects).toEqual([
      {
        nameSingular: 'provisionedList',
        id: expect.any(String),
        created: true,
      },
    ]);
    expect(applyResponse.body.data.fields[0].created).toBe(true);
    expect(applyResponse.body.data.indexes[0].created).toBe(true);

    const [object]: { workspaceId: string }[] =
      await global.testDataSource.query(
        `SELECT "workspaceId" FROM core."objectMetadata" WHERE id = $1`,
        [applyResponse.body.data.objects[0].id],
      );

    expect(object.workspaceId).toBe(createResponse.body.workspaceId);
  });

  it('applies the production crm schema once and then reports it as already applied', async () => {
    const createResponse = await postInternal('/internal/workspaces', {
      name: 'Crm Schema Provisioning',
      slug: uniqueSlug('crm-schema'),
      apiKeyName: 'regie-crm-api',
    });

    expect(createResponse.status).toBe(200);
    workspaceIds.push(createResponse.body.workspaceId);

    const applyCrmSchema = () =>
      makeRestAPIRequest({
        method: 'post',
        path: '/metadata/schema/apply',
        bearer: createResponse.body.apiKey.apiKey,
        body: crmSchemaApplyRequest,
      });

    const firstApplyStartedAt = performance.now();
    const firstResponse = await applyCrmSchema();
    const firstApplyDurationMs = performance.now() - firstApplyStartedAt;

    process.stdout.write(
      `crm schema first apply took ${firstApplyDurationMs.toFixed(0)}ms\n`,
    );

    expect(firstResponse.status).toBe(200);

    const first = firstResponse.body.data;

    expect(first.objects).toHaveLength(crmSchemaApplyRequest.objects.length);
    expect(first.fields).toHaveLength(crmSchemaApplyRequest.fields.length);
    expect(first.fieldSettings).toHaveLength(
      crmSchemaApplyRequest.fieldSettings.length,
    );
    expect(first.indexes).toHaveLength(crmSchemaApplyRequest.indexes.length);
    expect(first.views).toHaveLength(crmSchemaApplyRequest.views.length);
    expect(
      first.fields.map(
        ({
          objectNameSingular,
          name,
        }: {
          objectNameSingular: string;
          name: string;
        }) => `${objectNameSingular}.${name}`,
      ),
    ).toEqual(
      crmSchemaApplyRequest.fields.map(
        ({ objectNameSingular, name }) => `${objectNameSingular}.${name}`,
      ),
    );

    const metadataVersionAfterFirstApply = await readMetadataVersion(
      createResponse.body.workspaceId,
    );

    const secondResponse = await applyCrmSchema();

    expect(secondResponse.status).toBe(200);

    const second = secondResponse.body.data;

    expect(
      [
        ...second.objects,
        ...second.fields,
        ...second.indexes,
        ...second.views,
      ].filter(({ created }: ApplyResultEntry) => created !== false),
    ).toEqual([]);
    expect(
      second.fieldSettings.filter(
        ({ updated }: ApplyResultEntry) => updated !== false,
      ),
    ).toEqual([]);
    expect(await readMetadataVersion(createResponse.body.workspaceId)).toBe(
      metadataVersionAfterFirstApply,
    );
  });

  it('keeps the response unchanged when no API key is requested', async () => {
    const slug = uniqueSlug('plain-provisioning');

    const response = await postInternal('/internal/workspaces', {
      name: 'Plain Provisioning',
      slug,
    });

    expect(response.status).toBe(200);
    workspaceIds.push(response.body.workspaceId);

    expect(response.body).not.toHaveProperty('apiKey');
    expect(response.body).toMatchObject({
      ok: true,
      workspaceId: response.body.id,
      workspaceSubdomain: slug,
    });
  });

  it('rejects a schema on workspace creation', async () => {
    const slug = uniqueSlug('schema-on-create');

    const response = await postInternal('/internal/workspaces', {
      name: 'Schema On Create',
      slug,
      schema: SCHEMA,
    });

    expect(response.status).toBe(400);

    const workspaces: { id: string }[] = await global.testDataSource.query(
      'SELECT id FROM core.workspace WHERE subdomain = $1',
      [slug],
    );

    expect(workspaces).toEqual([]);
  });
});
