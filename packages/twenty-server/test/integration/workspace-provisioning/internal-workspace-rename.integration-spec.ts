import crypto from 'crypto';

import request from 'supertest';

import { type TwentyConfigService } from 'src/engine/core-modules/twenty-config/twenty-config.service';

import { makeRestAPIRequest } from 'test/integration/rest/utils/make-rest-api-request.util';
import { getAppProviderByClassName } from 'test/integration/utils/get-app-provider-by-class-name.util';

jest.useRealTimers();
jest.setTimeout(120_000);

const INTERNAL_TOKEN = 'workspace-rename-integration-token';

const internal = () => {
  const agent = request(global.app.getHttpServer());

  return {
    post: (path: string, body: object) =>
      agent.post(path).set('x-internal-token', INTERNAL_TOKEN).send(body),
    patch: (path: string, body: object) =>
      agent.patch(path).set('x-internal-token', INTERNAL_TOKEN).send(body),
    get: (path: string) =>
      agent.get(path).set('x-internal-token', INTERNAL_TOKEN),
  };
};

const uniqueSlug = (prefix: string) =>
  `${prefix}-${crypto.randomUUID().slice(0, 8)}`;

describe('internal workspace rename and lookup', () => {
  let configGetSpy: jest.SpyInstance;
  const workspaceIds: string[] = [];

  const createPooledWorkspace = async () => {
    const slug = uniqueSlug('pool');
    const response = await internal().post('/internal/workspaces', {
      name: 'Pooled workspace',
      slug,
      apiKeyName: 'regie-crm-api',
    });

    expect(response.status).toBe(200);
    workspaceIds.push(response.body.workspaceId);

    return {
      slug,
      workspaceId: response.body.workspaceId as string,
      apiKey: response.body.apiKey.apiKey as string,
    };
  };

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
    await global.testDataSource.query(
      'DELETE FROM core.workspace WHERE id = ANY($1::uuid[])',
      [workspaceIds],
    );
    configGetSpy.mockRestore();
  });

  it('moves a pooled workspace to the tenant slug and keeps its API key working', async () => {
    const pooled = await createPooledWorkspace();
    const tenantSlug = uniqueSlug('tenant');

    const rename = () =>
      internal().patch(`/internal/workspaces/${pooled.workspaceId}`, {
        name: 'Acme Tenant',
        slug: tenantSlug,
        primaryDomain: `https://${tenantSlug}.twenty.test`,
      });

    const renameStartedAt = performance.now();
    const renameResponse = await rename();

    process.stdout.write(
      `pooled workspace rename took ${(performance.now() - renameStartedAt).toFixed(0)}ms\n`,
    );

    expect(renameResponse.status).toBe(200);
    expect(renameResponse.body).toEqual({
      ok: true,
      id: pooled.workspaceId,
      workspaceId: pooled.workspaceId,
      workspaceUrl: `https://${tenantSlug}.twenty.test`,
      workspaceName: 'Acme Tenant',
      workspaceSubdomain: tenantSlug,
    });

    const [row]: { subdomain: string; displayName: string }[] =
      await global.testDataSource.query(
        'SELECT subdomain, "displayName" FROM core.workspace WHERE id = $1',
        [pooled.workspaceId],
      );

    expect(row).toEqual({ subdomain: tenantSlug, displayName: 'Acme Tenant' });

    const repeatResponse = await rename();

    expect(repeatResponse.status).toBe(200);
    expect(repeatResponse.body.workspaceSubdomain).toBe(tenantSlug);

    const recordsResponse = await makeRestAPIRequest({
      method: 'get',
      path: '/companies?limit=1',
      bearer: pooled.apiKey,
    });

    expect(recordsResponse.status).toBe(200);

    const lookupResponse = await internal().get(
      `/internal/workspaces?slug=${tenantSlug}`,
    );

    expect(lookupResponse.status).toBe(200);
    expect(lookupResponse.body).toMatchObject({
      workspaceId: pooled.workspaceId,
      workspaceSubdomain: tenantSlug,
      deleted: false,
    });

    const oldSlugResponse = await internal().get(
      `/internal/workspaces?slug=${pooled.slug}`,
    );

    expect(oldSlugResponse.status).toBe(404);
  });

  it('refuses a slug another workspace already holds', async () => {
    const first = await createPooledWorkspace();
    const second = await createPooledWorkspace();

    const response = await internal().patch(
      `/internal/workspaces/${second.workspaceId}`,
      { name: 'Taken', slug: first.slug },
    );

    expect(response.status).toBe(409);

    const [row]: { subdomain: string }[] = await global.testDataSource.query(
      'SELECT subdomain FROM core.workspace WHERE id = $1',
      [second.workspaceId],
    );

    expect(row.subdomain).toBe(second.slug);
  });

  it('returns 404 for a rename of an unknown workspace and a lookup of an unknown slug', async () => {
    const renameResponse = await internal().patch(
      `/internal/workspaces/${crypto.randomUUID()}`,
      { name: 'Missing', slug: uniqueSlug('tenant') },
    );
    const lookupResponse = await internal().get(
      `/internal/workspaces?slug=${uniqueSlug('pool')}`,
    );

    expect(renameResponse.status).toBe(404);
    expect(lookupResponse.status).toBe(404);
  });

  it('rejects a lookup without a slug', async () => {
    const response = await internal().get('/internal/workspaces');

    expect(response.status).toBe(400);
  });
});
