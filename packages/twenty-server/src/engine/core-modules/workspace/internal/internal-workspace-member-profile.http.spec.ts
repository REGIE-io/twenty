import { type INestApplication } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { Test } from '@nestjs/testing';

import { randomUUID } from 'crypto';

import request from 'supertest';
import { type FindOperator } from 'typeorm';

import { JwtWrapperService } from 'src/engine/core-modules/jwt/services/jwt-wrapper.service';
import { TwentyConfigService } from 'src/engine/core-modules/twenty-config/twenty-config.service';
import { UserSessionCookieService } from 'src/engine/core-modules/user-session/services/user-session-cookie.service';
import { InternalMetadataTokenGuard } from 'src/engine/core-modules/workspace/internal/guards/internal-metadata-token.guard';
import { InternalWorkspaceMemberProvisioningController } from 'src/engine/core-modules/workspace/internal/internal-workspace-member-provisioning.controller';
import { InternalWorkspaceMemberProvisioningService } from 'src/engine/core-modules/workspace/internal/internal-workspace-member-provisioning.service';
import { NoPermissionGuard } from 'src/engine/guards/no-permission.guard';
import { CookieSessionCsrfMiddleware } from 'src/engine/middlewares/cookie-session-csrf.middleware';

jest.useRealTimers();

const WORKSPACE_ID = '20202020-0000-4000-8000-000000000001';
const OTHER_WORKSPACE_ID = '20202020-0000-4000-8000-000000000002';
const MEMBER_ID = '30303030-0000-4000-8000-000000000001';
const OTHER_MEMBER_ID = '30303030-0000-4000-8000-000000000002';
const INTERNAL_TOKEN = 'workspace-member-profile-http-token';

const PROFILE = {
  email: 'new.owner@example.com',
  firstName: 'New',
  lastName: 'Owner',
  profilePolicy: 'provider',
};

type StoredMember = {
  id: string;
  userId: string;
  userEmail: string;
  name: { firstName: string; lastName: string };
  deletedAt?: Date;
};

type StoredUser = {
  id: string;
  email: string;
  firstName: string;
  lastName: string;
  isEmailVerified: boolean;
};

type StoredUserWorkspace = {
  id: string;
  userId: string;
  workspaceId: string;
};

type MemberWhere = {
  id?: string | FindOperator<string>;
  userId?: string;
  userEmail?: string | FindOperator<string>;
};

const makeDatabaseBoundary = () => {
  const membersByWorkspace = new Map<string, Map<string, StoredMember>>();
  const users = new Map<string, StoredUser>();
  const userWorkspaces = new Map<string, StoredUserWorkspace>();
  let contextWorkspaceId = WORKSPACE_ID;

  const membersFor = (workspaceId: string) => {
    const existing = membersByWorkspace.get(workspaceId);

    if (existing) {
      return existing;
    }

    const members = new Map<string, StoredMember>();

    membersByWorkspace.set(workspaceId, members);

    return members;
  };

  const workspaceRepository = {
    findOneBy: jest.fn(async ({ id }: { id: string }) =>
      [WORKSPACE_ID, OTHER_WORKSPACE_ID].includes(id) ? { id } : null,
    ),
  };

  const memberRepositoryFor = (workspaceId: string) => ({
    findOne: async ({
      where,
      withDeleted = false,
    }: {
      where: MemberWhere;
      withDeleted?: boolean;
    }) =>
      Array.from(membersFor(workspaceId).values()).find((member) => {
        const targetEmail =
          typeof where.userEmail === 'string'
            ? where.userEmail
            : where.userEmail?.objectLiteralParameters?.email;

        return (
          (withDeleted || member.deletedAt === undefined) &&
          (where.id === undefined ||
            (typeof where.id === 'string'
              ? member.id === where.id
              : member.id !== where.id.value)) &&
          (where.userId === undefined || member.userId === where.userId) &&
          (targetEmail === undefined ||
            member.userEmail.trim().toLowerCase() === targetEmail)
        );
      }) ?? null,
    insert: async (member: Omit<StoredMember, 'id'>) => {
      const savedMember = { ...member, id: randomUUID() };

      membersFor(workspaceId).set(savedMember.id, savedMember);

      return { identifiers: [{ id: savedMember.id }] };
    },
    update: async (
      { id }: { id: string },
      profile: Partial<Pick<StoredMember, 'name' | 'userEmail'>>,
    ) => {
      const member = membersFor(workspaceId).get(id);

      if (!member) {
        return { affected: 0 };
      }

      membersFor(workspaceId).set(id, { ...member, ...profile });

      return { affected: 1 };
    },
  });

  const userRepository = {
    findOne: jest.fn(
      async ({ where }: { where: { email: string } }) =>
        Array.from(users.values()).find((user) => user.email === where.email) ??
        null,
    ),
    create: jest.fn((user: Omit<StoredUser, 'id'>) => user),
    save: jest.fn(async (user: Omit<StoredUser, 'id'>) => {
      const savedUser = { ...user, id: randomUUID() };

      users.set(savedUser.id, savedUser);

      return savedUser;
    }),
  };

  const userWorkspaceRepository = {
    findOne: jest.fn(
      async ({ where }: { where: { userId: string; workspaceId: string } }) =>
        userWorkspaces.get(`${where.userId}:${where.workspaceId}`) ?? null,
    ),
    create: jest.fn(
      (membership: Omit<StoredUserWorkspace, 'id'>) => membership,
    ),
    save: jest.fn(async (membership: Omit<StoredUserWorkspace, 'id'>) => {
      const savedMembership = { ...membership, id: randomUUID() };

      userWorkspaces.set(
        `${membership.userId}:${membership.workspaceId}`,
        savedMembership,
      );

      return savedMembership;
    }),
  };

  const globalWorkspaceOrmManager = {
    executeInWorkspaceContext: async <Result>(
      callback: () => Promise<Result>,
      context: { workspace: { id: string } },
    ) => {
      const previousWorkspaceId = contextWorkspaceId;

      contextWorkspaceId = context.workspace.id;
      try {
        return await callback();
      } finally {
        contextWorkspaceId = previousWorkspaceId;
      }
    },
    getRepository: async (workspaceId: string) =>
      memberRepositoryFor(workspaceId),
    runInWorkspaceTransaction: async <Result>(
      callback: (scope: {
        getRepository: () => ReturnType<typeof memberRepositoryFor>;
        executeRawQuery: () => Promise<unknown[]>;
      }) => Promise<Result>,
    ) =>
      await callback({
        getRepository: () => memberRepositoryFor(contextWorkspaceId),
        executeRawQuery: async () => [],
      }),
  };

  return {
    membersFor,
    membersByWorkspace,
    users,
    userWorkspaces,
    workspaceRepository,
    userRepository,
    userWorkspaceRepository,
    globalWorkspaceOrmManager,
  };
};

describe('Internal workspace member profile HTTP contract', () => {
  let app: INestApplication;
  const database = makeDatabaseBoundary();

  const memberUrl = (
    workspaceId = WORKSPACE_ID,
    workspaceMemberId = MEMBER_ID,
  ) => `/internal/workspaces/${workspaceId}/members/${workspaceMemberId}`;

  const patchProfile = (body: object = PROFILE) =>
    request(app.getHttpServer())
      .patch(memberUrl())
      .set('Authorization', `Bearer ${INTERNAL_TOKEN}`)
      .send(body);

  beforeAll(async () => {
    const config = {
      get: (key: string) => {
        if (key === 'TWENTY_INTERNAL_METADATA_TOKEN') {
          return INTERNAL_TOKEN;
        }

        if (key === 'SERVER_URL') {
          return 'http://localhost:3000';
        }

        return 'lax';
      },
    } as TwentyConfigService;
    const service = new InternalWorkspaceMemberProvisioningService(
      database.workspaceRepository as never,
      database.userRepository as never,
      database.userWorkspaceRepository as never,
      database.globalWorkspaceOrmManager as never,
    );
    const module = await Test.createTestingModule({
      controllers: [InternalWorkspaceMemberProvisioningController],
      providers: [
        InternalMetadataTokenGuard,
        NoPermissionGuard,
        { provide: TwentyConfigService, useValue: config },
        {
          provide: InternalWorkspaceMemberProvisioningService,
          useValue: service,
        },
      ],
    }).compile();

    app = module.createNestApplication();

    // AppModule installs this middleware on all routes, including /internal.
    const csrf = new CookieSessionCsrfMiddleware(
      config,
      new UserSessionCookieService(config),
      new JwtWrapperService(new JwtService(), config, {} as never, {} as never),
    );

    app.use(csrf.use.bind(csrf));
    await app.listen(0, '127.0.0.1');
  });

  beforeEach(() => {
    database.membersByWorkspace.clear();
    database.users.clear();
    database.userWorkspaces.clear();
    database.membersFor(WORKSPACE_ID).set(MEMBER_ID, {
      id: MEMBER_ID,
      userId: 'core-user-existing',
      userEmail: 'original@example.com',
      name: { firstName: 'Original', lastName: 'Owner' },
    });
    database.users.set('core-user-existing', {
      id: 'core-user-existing',
      email: 'original@example.com',
      firstName: 'Original',
      lastName: 'Owner',
      isEmailVerified: true,
    });
    jest.clearAllMocks();
  });

  afterAll(async () => {
    await app.close();
  });

  it('accepts the Go worker payload and updates only the same workspace member', async () => {
    const originalCoreUser = structuredClone(
      database.users.get('core-user-existing'),
    );
    const response = await patchProfile({
      ...PROFILE,
      email: '  NEW.OWNER@Example.COM ',
    }).expect(200);

    expect(response.body).toMatchObject({
      workspaceId: WORKSPACE_ID,
      workspaceMemberId: MEMBER_ID,
    });
    expect(database.membersFor(WORKSPACE_ID).get(MEMBER_ID)).toEqual({
      id: MEMBER_ID,
      userId: 'core-user-existing',
      userEmail: 'new.owner@example.com',
      name: { firstName: 'New', lastName: 'Owner' },
    });
    expect(database.users.get('core-user-existing')).toEqual(originalCoreUser);
    expect(database.userRepository.save).not.toHaveBeenCalled();
    expect(database.userWorkspaceRepository.save).not.toHaveBeenCalled();
  });

  it('returns the same identity for repeated identical requests', async () => {
    const first = await patchProfile().expect(200);
    const second = await patchProfile().expect(200);

    expect(second.body).toEqual(first.body);
    expect(database.membersFor(WORKSPACE_ID).size).toBe(1);
    expect(database.users.size).toBe(1);
  });

  it('supports the existing x-internal-token header without browser cookies', async () => {
    await request(app.getHttpServer())
      .patch(memberUrl())
      .set('x-internal-token', INTERNAL_TOKEN)
      .send(PROFILE)
      .expect(200);
  });

  it.each([undefined, 'wrong-token'])(
    'rejects token %s before database access',
    async (token) => {
      const pending = request(app.getHttpServer())
        .patch(memberUrl())
        .send(PROFILE);

      if (token !== undefined) {
        pending.set('Authorization', `Bearer ${token}`);
      }

      await pending.expect(403);

      expect(database.workspaceRepository.findOneBy).not.toHaveBeenCalled();
      expect(database.membersFor(WORKSPACE_ID).get(MEMBER_ID)?.userEmail).toBe(
        'original@example.com',
      );
    },
  );

  it('does not let a valid fallback header override a wrong bearer token', async () => {
    await request(app.getHttpServer())
      .patch(memberUrl())
      .set('Authorization', 'Bearer wrong-token')
      .set('x-internal-token', INTERNAL_TOKEN)
      .send(PROFILE)
      .expect(403);

    expect(database.workspaceRepository.findOneBy).not.toHaveBeenCalled();
  });

  it.each([
    { ...PROFILE, email: 'not-an-email' },
    { ...PROFILE, email: null },
    { ...PROFILE, firstName: null },
    { ...PROFILE, lastName: 42 },
    { ...PROFILE, profilePolicy: 'overwrite' },
    { ...PROFILE, id: OTHER_MEMBER_ID },
    { ...PROFILE, userId: 'different-core-user' },
    { ...PROFILE, role: 'ADMIN' },
    { ...PROFILE, workspaceId: OTHER_WORKSPACE_ID },
    {
      firstName: PROFILE.firstName,
      lastName: PROFILE.lastName,
      profilePolicy: PROFILE.profilePolicy,
    },
    {
      email: PROFILE.email,
      lastName: PROFILE.lastName,
      profilePolicy: PROFILE.profilePolicy,
    },
    {
      email: PROFILE.email,
      firstName: PROFILE.firstName,
      profilePolicy: PROFILE.profilePolicy,
    },
    {
      email: PROFILE.email,
      firstName: PROFILE.firstName,
      lastName: PROFILE.lastName,
    },
  ])('rejects an invalid or privileged request body %#', async (body) => {
    await patchProfile(body).expect(400);

    expect(database.workspaceRepository.findOneBy).not.toHaveBeenCalled();
    expect(database.membersFor(WORKSPACE_ID).get(MEMBER_ID)?.userEmail).toBe(
      'original@example.com',
    );
  });

  it.each([
    ['invalid-workspace', MEMBER_ID],
    [WORKSPACE_ID, 'invalid-member'],
  ])(
    'rejects a malformed route identity %s / %s',
    async (workspaceId, memberId) => {
      await request(app.getHttpServer())
        .patch(memberUrl(workspaceId, memberId))
        .set('Authorization', `Bearer ${INTERNAL_TOKEN}`)
        .send(PROFILE)
        .expect(400);

      expect(database.workspaceRepository.findOneBy).not.toHaveBeenCalled();
    },
  );

  it('returns 404 for a missing member without creating a replacement', async () => {
    database.membersFor(WORKSPACE_ID).clear();

    await patchProfile().expect(404);

    expect(database.membersFor(WORKSPACE_ID).size).toBe(0);
    expect(database.userRepository.save).not.toHaveBeenCalled();
  });

  it('returns 404 for a missing workspace without changing an existing member', async () => {
    await request(app.getHttpServer())
      .patch(memberUrl('20202020-0000-4000-8000-000000000404'))
      .set('Authorization', `Bearer ${INTERNAL_TOKEN}`)
      .send(PROFILE)
      .expect(404);

    expect(database.membersFor(WORKSPACE_ID).get(MEMBER_ID)?.userEmail).toBe(
      'original@example.com',
    );
  });

  it('cannot update a member through another workspace', async () => {
    const original = structuredClone(
      database.membersFor(WORKSPACE_ID).get(MEMBER_ID),
    );

    await request(app.getHttpServer())
      .patch(memberUrl(OTHER_WORKSPACE_ID))
      .set('Authorization', `Bearer ${INTERNAL_TOKEN}`)
      .send(PROFILE)
      .expect(404);

    expect(database.membersFor(WORKSPACE_ID).get(MEMBER_ID)).toEqual(original);
    expect(database.membersFor(OTHER_WORKSPACE_ID).size).toBe(0);
  });

  it.each([false, true])(
    'returns 409 for a conflicting member (deleted=%s) and changes nothing',
    async (deleted) => {
      database.membersFor(WORKSPACE_ID).set(OTHER_MEMBER_ID, {
        id: OTHER_MEMBER_ID,
        userId: 'another-core-user',
        userEmail: ' NEW.OWNER@example.com ',
        name: { firstName: 'Another', lastName: 'Member' },
        ...(deleted ? { deletedAt: new Date('2026-01-01T00:00:00Z') } : {}),
      });
      const originalMembers = structuredClone(
        Array.from(database.membersFor(WORKSPACE_ID).values()),
      );

      await patchProfile().expect(409);

      expect(Array.from(database.membersFor(WORKSPACE_ID).values())).toEqual(
        originalMembers,
      );
    },
  );

  it('preserves Go-managed email and names with fill_missing', async () => {
    const original = structuredClone(
      database.membersFor(WORKSPACE_ID).get(MEMBER_ID),
    );

    await patchProfile({ ...PROFILE, profilePolicy: 'fill_missing' }).expect(
      200,
    );

    expect(database.membersFor(WORKSPACE_ID).get(MEMBER_ID)).toEqual(original);
  });

  it('fills blank names only when fill_missing matches the existing email', async () => {
    const member = database.membersFor(WORKSPACE_ID).get(MEMBER_ID)!;

    member.name = { firstName: '  ', lastName: 'Go-managed' };

    await patchProfile({
      ...PROFILE,
      email: 'ORIGINAL@example.com',
      profilePolicy: 'fill_missing',
    }).expect(200);

    expect(database.membersFor(WORKSPACE_ID).get(MEMBER_ID)?.name).toEqual({
      firstName: 'New',
      lastName: 'Go-managed',
    });
  });

  it.each(['provider', 'fill_missing'])(
    'does not erase names for blank %s source fields',
    async (profilePolicy) => {
      await patchProfile({
        email: 'original@example.com',
        firstName: '',
        lastName: '   ',
        profilePolicy,
      }).expect(200);

      expect(database.membersFor(WORKSPACE_ID).get(MEMBER_ID)?.name).toEqual({
        firstName: 'Original',
        lastName: 'Owner',
      });
    },
  );

  it('keeps the existing POST creation and reuse contract', async () => {
    const createMember = () =>
      request(app.getHttpServer())
        .post(`/internal/workspaces/${WORKSPACE_ID}/members`)
        .set('Authorization', `Bearer ${INTERNAL_TOKEN}`)
        .send({
          id: 'go-user-1',
          email: 'created@example.com',
          firstName: 'Created',
          lastName: 'Owner',
        });
    const first = await createMember().expect(200);
    const second = await createMember().expect(200);

    expect(first.body).toMatchObject({
      workspaceId: WORKSPACE_ID,
      workspaceMemberId: expect.any(String),
      userId: expect.any(String),
      appUserId: 'go-user-1',
    });
    expect(second.body).toEqual(first.body);
    expect(database.membersFor(WORKSPACE_ID).size).toBe(2);
    expect(database.users.size).toBe(2);
    expect(database.userWorkspaces.size).toBe(1);
  });
});
