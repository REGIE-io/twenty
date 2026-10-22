import crypto from 'crypto';

import request from 'supertest';
import { FeatureFlagKey } from 'twenty-shared/types';

import { type FeatureFlagService } from 'src/engine/core-modules/feature-flag/services/feature-flag.service';
import { type TwentyConfigService } from 'src/engine/core-modules/twenty-config/twenty-config.service';
import { getWorkspaceSchemaName } from 'src/engine/workspace-datasource/utils/get-workspace-schema-name.util';

import { getAppProviderByClassName } from 'test/integration/utils/get-app-provider-by-class-name.util';

jest.useRealTimers();
jest.setTimeout(120_000);

const INTERNAL_TOKEN = 'workspace-member-profile-integration-token';

type ProvisionedMember = {
  workspaceMemberId: string;
  userId: string;
  appUserId: string;
  email: string;
};

type WorkspaceFixture = {
  workspaceId: string;
  providerMember: ProvisionedMember;
  goMember: ProvisionedMember;
};

type StoredMemberProfile = {
  id: string;
  userId: string;
  userEmail: string;
  firstName: string;
  lastName: string;
};

type StoredCoreUserProfile = {
  id: string;
  email: string;
  firstName: string;
  lastName: string;
  isEmailVerified: boolean;
  passwordHash: string | null;
  disabled: boolean;
  canAccessFullAdminPanel: boolean;
};

const postInternal = (path: string, body: object) =>
  request(global.app.getHttpServer())
    .post(path)
    .set('Authorization', `Bearer ${INTERNAL_TOKEN}`)
    .send(body);

// Match the deployed Go worker request, including its auth header and four body fields.
const patchProfile = (
  workspaceId: string,
  memberId: string,
  body: {
    email: string;
    firstName: string;
    lastName: string;
    profilePolicy: 'provider' | 'fill_missing';
  },
) =>
  request(global.app.getHttpServer())
    .patch(`/internal/workspaces/${workspaceId}/members/${memberId}`)
    .set('Authorization', `Bearer ${INTERNAL_TOKEN}`)
    .send(body);

const readMemberProfile = async (
  workspaceId: string,
  memberId: string,
): Promise<StoredMemberProfile> => {
  const rows: StoredMemberProfile[] = await global.testDataSource.query(
    `SELECT id, "userId", "userEmail", "nameFirstName" AS "firstName", "nameLastName" AS "lastName"
     FROM "${getWorkspaceSchemaName(workspaceId)}"."workspaceMember"
     WHERE id = $1`,
    [memberId],
  );

  expect(rows).toHaveLength(1);

  return rows[0];
};

const readCoreUserProfile = async (
  userId: string,
): Promise<StoredCoreUserProfile> => {
  const rows: StoredCoreUserProfile[] = await global.testDataSource.query(
    `SELECT id, email, "firstName", "lastName", "isEmailVerified", "passwordHash", disabled, "canAccessFullAdminPanel"
     FROM core."user" WHERE id = $1`,
    [userId],
  );

  expect(rows).toHaveLength(1);

  return rows[0];
};

describe('internal workspace member profile with the full application', () => {
  let configGetSpy: jest.SpyInstance;
  const workspaceIds: string[] = [];
  const userIds: string[] = [];
  const fixtures: WorkspaceFixture[] = [];

  const createMember = async (
    workspaceId: string,
    profile: { email: string; firstName: string; lastName: string },
  ): Promise<ProvisionedMember> => {
    const appUserId = `go-profile-test-${crypto.randomUUID()}`;
    const response = await postInternal(
      `/internal/workspaces/${workspaceId}/members`,
      { id: appUserId, ...profile },
    );

    expect(response.status).toBe(200);
    expect(response.body).toMatchObject({
      workspaceId,
      workspaceMemberId: expect.any(String),
      userId: expect.any(String),
      appUserId,
    });
    userIds.push(response.body.userId);

    return {
      workspaceMemberId: response.body.workspaceMemberId,
      userId: response.body.userId,
      appUserId,
      email: profile.email,
    };
  };

  beforeAll(async () => {
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

    const featureFlagService =
      getAppProviderByClassName<FeatureFlagService>('FeatureFlagService');

    for (const useOrmV2 of [false, true]) {
      const runId = crypto.randomUUID().slice(0, 8);
      const response = await postInternal('/internal/workspaces', {
        name: `Owner profile ORM ${useOrmV2 ? 'v2' : 'v1'}`,
        slug: `owner-profile-${runId}`,
      });

      expect(response.status).toBe(200);
      expect(response.body.workspaceId).toEqual(expect.any(String));

      const workspaceId: string = response.body.workspaceId;

      workspaceIds.push(workspaceId);
      await featureFlagService.upsertWorkspaceFeatureFlag({
        workspaceId,
        featureFlag: FeatureFlagKey.IS_ORM_V2_READ_PATH_ENABLED,
        value: useOrmV2,
      });
      expect(
        await featureFlagService.isFeatureEnabled(
          FeatureFlagKey.IS_ORM_V2_READ_PATH_ENABLED,
          workspaceId,
        ),
      ).toBe(useOrmV2);

      fixtures.push({
        workspaceId,
        providerMember: await createMember(workspaceId, {
          email: `provider-${runId}@example.com`,
          firstName: 'Original',
          lastName: 'Provider',
        }),
        goMember: await createMember(workspaceId, {
          email: `go-${runId}@example.com`,
          firstName: '',
          lastName: 'Go Managed',
        }),
      });
    }
  });

  afterAll(async () => {
    try {
      // Keep the shared workspace-provisioning user; only remove this test's unique members.
      await global.testDataSource.query(
        'DELETE FROM core.workspace WHERE id = ANY($1::uuid[])',
        [workspaceIds],
      );
      await global.testDataSource.query(
        `DELETE FROM core."user" WHERE id = ANY($1::uuid[])
         AND NOT EXISTS (SELECT 1 FROM core."userWorkspace" WHERE "userId" = core."user".id)`,
        [userIds],
      );
    } finally {
      configGetSpy?.mockRestore();
    }
  });

  describe.each([
    { label: 'ORM v1', fixtureIndex: 0 },
    { label: 'ORM v2', fixtureIndex: 1 },
  ])('$label', ({ fixtureIndex }) => {
    it('persists provider changes on the same member and safely retries the worker request', async () => {
      const { workspaceId, providerMember } = fixtures[fixtureIndex];
      const originalCoreUser = await readCoreUserProfile(providerMember.userId);
      const updatedEmail = `updated-${crypto.randomUUID()}@example.com`;
      const body = {
        email: updatedEmail,
        firstName: 'Updated',
        lastName: 'CRM Owner',
        profilePolicy: 'provider' as const,
      };

      const first = await patchProfile(
        workspaceId,
        providerMember.workspaceMemberId,
        body,
      );

      expect(first.status).toBe(200);
      expect(first.body).toEqual({
        workspaceId,
        workspaceMemberId: providerMember.workspaceMemberId,
      });
      expect(
        await readMemberProfile(workspaceId, providerMember.workspaceMemberId),
      ).toEqual({
        id: providerMember.workspaceMemberId,
        userId: providerMember.userId,
        userEmail: updatedEmail,
        firstName: 'Updated',
        lastName: 'CRM Owner',
      });

      const second = await patchProfile(
        workspaceId,
        providerMember.workspaceMemberId,
        body,
      );

      expect(second.status).toBe(200);
      expect(second.body).toEqual(first.body);
      expect(await readCoreUserProfile(providerMember.userId)).toEqual(
        originalCoreUser,
      );

      const reuse = await postInternal(
        `/internal/workspaces/${workspaceId}/members`,
        {
          id: providerMember.appUserId,
          email: providerMember.email,
          firstName: 'Must not overwrite',
          lastName: 'Must not overwrite',
        },
      );

      expect(reuse.status).toBe(200);
      expect(reuse.body.workspaceMemberId).toBe(
        providerMember.workspaceMemberId,
      );
      expect(
        await readMemberProfile(workspaceId, providerMember.workspaceMemberId),
      ).toMatchObject({ userEmail: updatedEmail, firstName: 'Updated' });
    });

    it('preserves Go identity and fills only blank names for matching emails', async () => {
      const { workspaceId, goMember } = fixtures[fixtureIndex];
      const original = await readMemberProfile(
        workspaceId,
        goMember.workspaceMemberId,
      );
      const originalCoreUser = await readCoreUserProfile(goMember.userId);

      const mismatch = await patchProfile(
        workspaceId,
        goMember.workspaceMemberId,
        {
          email: `different-${crypto.randomUUID()}@example.com`,
          firstName: 'Provider',
          lastName: 'Must not replace',
          profilePolicy: 'fill_missing',
        },
      );

      expect(mismatch.status).toBe(200);
      expect(
        await readMemberProfile(workspaceId, goMember.workspaceMemberId),
      ).toEqual(original);

      const matched = await patchProfile(
        workspaceId,
        goMember.workspaceMemberId,
        {
          email: goMember.email.toUpperCase(),
          firstName: 'Filled',
          lastName: 'Must not replace',
          profilePolicy: 'fill_missing',
        },
      );

      expect(matched.status).toBe(200);
      expect(matched.body.workspaceMemberId).toBe(goMember.workspaceMemberId);
      expect(
        await readMemberProfile(workspaceId, goMember.workspaceMemberId),
      ).toEqual({ ...original, firstName: 'Filled' });
      expect(await readCoreUserProfile(goMember.userId)).toEqual(
        originalCoreUser,
      );
    });

    it('returns 409 for another member email without a partial name update', async () => {
      const { workspaceId, providerMember, goMember } = fixtures[fixtureIndex];
      const original = await readMemberProfile(
        workspaceId,
        providerMember.workspaceMemberId,
      );
      const response = await patchProfile(
        workspaceId,
        providerMember.workspaceMemberId,
        {
          email: ` ${goMember.email.toUpperCase()} `,
          firstName: 'Must not save',
          lastName: 'Must not save',
          profilePolicy: 'provider',
        },
      );

      expect(response.status).toBe(409);
      expect(
        await readMemberProfile(workspaceId, providerMember.workspaceMemberId),
      ).toEqual(original);
    });

    it('returns 404 when a valid member belongs to another workspace', async () => {
      const { workspaceId, providerMember } = fixtures[fixtureIndex];
      const otherWorkspace = fixtures[1 - fixtureIndex];
      const original = await readMemberProfile(
        workspaceId,
        providerMember.workspaceMemberId,
      );
      const response = await patchProfile(
        otherWorkspace.workspaceId,
        providerMember.workspaceMemberId,
        {
          email: 'wrong-workspace@example.com',
          firstName: 'Must not save',
          lastName: 'Must not save',
          profilePolicy: 'provider',
        },
      );

      expect(response.status).toBe(404);
      expect(
        await readMemberProfile(workspaceId, providerMember.workspaceMemberId),
      ).toEqual(original);
    });
  });
});
