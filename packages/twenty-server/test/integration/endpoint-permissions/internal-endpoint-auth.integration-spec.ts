import request from 'supertest';

import { type TwentyConfigService } from 'src/engine/core-modules/twenty-config/twenty-config.service';
import { SEED_APPLE_WORKSPACE_ID } from 'src/engine/workspace-manager/dev-seeder/core/constants/seeder-workspaces.constant';

import { getAppProviderByClassName } from 'test/integration/utils/get-app-provider-by-class-name.util';

const WORKSPACE_PATH = `/internal/workspaces/${SEED_APPLE_WORKSPACE_ID}`;

// The permission snapshot only records AuthPrincipalGuard, not the internal token guard.
describe('internal endpoint authentication', () => {
  let configGetSpy: jest.SpyInstance;

  beforeAll(() => {
    const config = getAppProviderByClassName<TwentyConfigService>(
      'TwentyConfigService',
    );
    const originalGet = config.get.bind(config);

    configGetSpy = jest
      .spyOn(config, 'get')
      .mockImplementation(((key: Parameters<TwentyConfigService['get']>[0]) =>
        key === 'TWENTY_INTERNAL_METADATA_TOKEN'
          ? 'endpoint-auth-integration-token'
          : originalGet(key)) as TwentyConfigService['get']);
  });

  afterAll(() => {
    configGetSpy.mockRestore();
  });

  it.each([
    ['post', '/internal/workspaces'],
    ['get', '/internal/workspaces'],
    ['patch', WORKSPACE_PATH],
    ['post', `${WORKSPACE_PATH}/activate`],
    ['delete', WORKSPACE_PATH],
    ['post', `${WORKSPACE_PATH}/e2e-marker`],
    ['post', `${WORKSPACE_PATH}/api-keys`],
    ['post', `${WORKSPACE_PATH}/members`],
    ['post', `${WORKSPACE_PATH}/connected-accounts`],
    [
      'post',
      `${WORKSPACE_PATH}/connected-accounts/${SEED_APPLE_WORKSPACE_ID}/detach`,
    ],
    ['get', `${WORKSPACE_PATH}/calendar-channels/${SEED_APPLE_WORKSPACE_ID}`],
    ['post', `${WORKSPACE_PATH}/instant-hard-deletion`],
  ] as const)(
    'rejects missing or invalid internal credentials on %s %s',
    async (method, path) => {
      const server = global.app.getHttpServer();

      await request(server)[method](path).expect(403);
      await request(server)
        [method](path)
        .set('Authorization', 'Bearer invalid-internal-token')
        .expect(403);
      await request(server)
        [method](path)
        .set('x-internal-token', 'invalid-internal-token')
        .expect(403);
    },
  );
});
