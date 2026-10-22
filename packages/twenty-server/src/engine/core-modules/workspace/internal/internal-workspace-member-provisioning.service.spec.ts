import {
  BadRequestException,
  ConflictException,
  NotFoundException,
} from '@nestjs/common';
import { FindOperator, QueryFailedError } from 'typeorm';

import { InternalWorkspaceMemberProvisioningService } from 'src/engine/core-modules/workspace/internal/internal-workspace-member-provisioning.service';
import { type UpdateWorkspaceMemberProfileInput } from 'src/engine/core-modules/workspace/internal/types/internal-workspace-member-provisioning.type';

const WORKSPACE_ID = '20202020-0000-4000-8000-000000000001';

const uniqueViolation = (constraint: string) =>
  new QueryFailedError('INSERT', [], {
    code: '23505',
    constraint,
  } as any);

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

type StoredWorkspaceMember = {
  id: string;
  userId: string;
  userEmail: string;
  name: {
    firstName: string;
    lastName: string;
  };
};

const makeServiceHarness = () => {
  const users = new Map<string, StoredUser>();
  const userWorkspaces = new Map<string, StoredUserWorkspace>();
  const workspaceMembers = new Map<string, StoredWorkspaceMember>();

  let userSequence = 0;
  let userWorkspaceSequence = 0;
  let workspaceMemberSequence = 0;
  let transactionComplete = Promise.resolve();

  const workspaceRepository = {
    findOneBy: jest.fn(async ({ id }: { id: string }) =>
      id === WORKSPACE_ID ? { id: WORKSPACE_ID } : null,
    ),
  };

  const userRepository = {
    findOne: jest.fn(
      async ({ where: { email } }: { where: { email: string } }) =>
        users.get(email) ?? null,
    ),
    create: jest.fn((user: Omit<StoredUser, 'id'>) => user),
    save: jest.fn(async (user: Omit<StoredUser, 'id'>) => {
      await Promise.resolve();

      if (users.has(user.email)) {
        throw uniqueViolation('UQ_USER_EMAIL');
      }

      const savedUser = {
        ...user,
        id: `user-${++userSequence}`,
      };

      users.set(savedUser.email, savedUser);

      return savedUser;
    }),
  };

  const userWorkspaceRepository = {
    findOne: jest.fn(
      async ({
        where: { userId, workspaceId },
      }: {
        where: { userId: string; workspaceId: string };
      }) => userWorkspaces.get(`${userId}:${workspaceId}`) ?? null,
    ),
    create: jest.fn((userWorkspace: Omit<StoredUserWorkspace, 'id'>) => ({
      ...userWorkspace,
    })),
    save: jest.fn(async (userWorkspace: Omit<StoredUserWorkspace, 'id'>) => {
      await Promise.resolve();

      const key = `${userWorkspace.userId}:${userWorkspace.workspaceId}`;

      if (userWorkspaces.has(key)) {
        throw uniqueViolation('IDX_USER_WORKSPACE_USER_ID_WORKSPACE_ID_UNIQUE');
      }

      const savedUserWorkspace = {
        ...userWorkspace,
        id: `user-workspace-${++userWorkspaceSequence}`,
      };

      userWorkspaces.set(key, savedUserWorkspace);

      return savedUserWorkspace;
    }),
  };

  const workspaceMemberRepository = {
    findOne: jest.fn(
      async ({
        where,
      }: {
        where: {
          id?: string | FindOperator<string>;
          userEmail?: string | FindOperator<string>;
          userId?: string;
        };
      }) => {
        if (typeof where.id === 'string') {
          return (
            Array.from(workspaceMembers.values()).find(
              (member) => member.id === where.id,
            ) ?? null
          );
        }

        if (where.userEmail instanceof FindOperator) {
          const email = where.userEmail.objectLiteralParameters?.email;
          const excludedId =
            where.id instanceof FindOperator ? where.id.value : undefined;

          return (
            Array.from(workspaceMembers.values()).find(
              (member) =>
                member.id !== excludedId &&
                member.userEmail.trim().toLowerCase() === email,
            ) ?? null
          );
        }

        if (where.userEmail !== undefined) {
          return workspaceMembers.get(where.userEmail) ?? null;
        }

        if (where.userId !== undefined) {
          return (
            Array.from(workspaceMembers.values()).find(
              (member) => member.userId === where.userId,
            ) ?? null
          );
        }

        return null;
      },
    ),
    update: jest.fn(
      async (
        { id }: { id: string },
        update: Pick<StoredWorkspaceMember, 'userEmail' | 'name'>,
      ) => {
        const member = Array.from(workspaceMembers.values()).find(
          (workspaceMember) => workspaceMember.id === id,
        );

        if (!member) {
          return { affected: 0 };
        }

        workspaceMembers.delete(member.userEmail);
        Object.assign(member, update);
        workspaceMembers.set(member.userEmail, member);

        return { affected: 1 };
      },
    ),
    insert: jest.fn(
      async (
        workspaceMember: Omit<StoredWorkspaceMember, 'id'> & {
          colorScheme: string;
          locale: string;
          avatarUrl: string | null;
        },
      ) => {
        await Promise.resolve();

        if (workspaceMembers.has(workspaceMember.userEmail)) {
          throw uniqueViolation('IDX_WORKSPACE_MEMBER_USER_EMAIL_UNIQUE');
        }

        const savedWorkspaceMember = {
          id: `workspace-member-${++workspaceMemberSequence}`,
          userId: workspaceMember.userId,
          userEmail: workspaceMember.userEmail,
          name: workspaceMember.name,
        };

        workspaceMembers.set(
          savedWorkspaceMember.userEmail,
          savedWorkspaceMember,
        );

        return { identifiers: [{ id: savedWorkspaceMember.id }] };
      },
    ),
  };

  const transactionScope = {
    executeRawQuery: jest.fn(async () => []),
    getRepository: jest.fn(() => workspaceMemberRepository),
  };

  const globalWorkspaceOrmManager = {
    executeInWorkspaceContext: jest.fn(
      async (callback: () => Promise<unknown>) => await callback(),
    ),
    getRepository: jest.fn(async () => workspaceMemberRepository),
    runInWorkspaceTransaction: jest.fn(
      async (
        callback: (scope: typeof transactionScope) => Promise<unknown>,
      ) => {
        const pendingTransaction = transactionComplete;
        let releaseTransaction: () => void = () => undefined;

        transactionComplete = new Promise<void>((resolve) => {
          releaseTransaction = resolve;
        });
        await pendingTransaction;

        try {
          return await callback(transactionScope);
        } finally {
          releaseTransaction();
        }
      },
    ),
  };

  const service = new InternalWorkspaceMemberProvisioningService(
    workspaceRepository as never,
    userRepository as never,
    userWorkspaceRepository as never,
    globalWorkspaceOrmManager as never,
  );

  return {
    globalWorkspaceOrmManager,
    service,
    transactionScope,
    stores: {
      users,
      userWorkspaces,
      workspaceMembers,
    },
    repositories: {
      userRepository,
      userWorkspaceRepository,
      workspaceMemberRepository,
      workspaceRepository,
    },
  };
};

describe('InternalWorkspaceMemberProvisioningService', () => {
  it('creates a core user and workspace member for a new normalized email', async () => {
    const { repositories, service, stores } = makeServiceHarness();

    const result = await service.provisionWorkspaceMember({
      workspaceId: WORKSPACE_ID,
      id: 'workos-user-1',
      email: '  ADA@Example.COM ',
      firstName: 'Ada',
      lastName: 'Lovelace',
    });

    expect(result).toEqual({
      workspaceMemberId: 'workspace-member-1',
      userId: 'user-1',
      appUserId: 'workos-user-1',
      workspaceId: WORKSPACE_ID,
    });
    expect(stores.users.get('ada@example.com')).toMatchObject({
      email: 'ada@example.com',
      firstName: 'Ada',
      lastName: 'Lovelace',
      isEmailVerified: true,
    });
    expect(repositories.userRepository.create).toHaveBeenCalledWith({
      email: 'ada@example.com',
      firstName: 'Ada',
      lastName: 'Lovelace',
      isEmailVerified: true,
    });
    expect(JSON.stringify(Array.from(stores.users.values()))).not.toContain(
      'workos-user-1',
    );
  });

  it('reuses an existing core user when email already exists', async () => {
    const { service, stores } = makeServiceHarness();

    stores.users.set('ada@example.com', {
      id: 'existing-user-id',
      email: 'ada@example.com',
      firstName: 'Ada',
      lastName: 'Lovelace',
      isEmailVerified: true,
    });

    const result = await service.provisionWorkspaceMember({
      workspaceId: WORKSPACE_ID,
      id: 'workos-user-2',
      email: 'ada@example.com',
      firstName: null,
      lastName: null,
    });

    expect(result.userId).toBe('existing-user-id');
    expect(stores.users.size).toBe(1);
    expect(stores.workspaceMembers.get('ada@example.com')).toMatchObject({
      userId: 'existing-user-id',
      userEmail: 'ada@example.com',
    });
  });

  it('reuses a workspace member when one already exists', async () => {
    const { service, stores } = makeServiceHarness();

    stores.users.set('ada@example.com', {
      id: 'user-1',
      email: 'ada@example.com',
      firstName: 'Ada',
      lastName: 'Lovelace',
      isEmailVerified: true,
    });
    stores.userWorkspaces.set(`user-1:${WORKSPACE_ID}`, {
      id: 'user-workspace-1',
      userId: 'user-1',
      workspaceId: WORKSPACE_ID,
    });
    stores.workspaceMembers.set('ada@example.com', {
      id: 'workspace-member-existing',
      userId: 'user-1',
      userEmail: 'ada@example.com',
      name: { firstName: 'Ada', lastName: 'Lovelace' },
    });

    const result = await service.provisionWorkspaceMember({
      workspaceId: WORKSPACE_ID,
      id: 'workos-user-3',
      email: 'ada@example.com',
      firstName: 'Ada',
      lastName: 'Lovelace',
    });

    expect(result.workspaceMemberId).toBe('workspace-member-existing');
    expect(stores.workspaceMembers.size).toBe(1);
  });

  it('returns the same workspace member for repeated identical requests', async () => {
    const { service, stores } = makeServiceHarness();
    const request = {
      workspaceId: WORKSPACE_ID,
      id: 'workos-user-4',
      email: 'ada@example.com',
      firstName: 'Ada',
      lastName: 'Lovelace',
    };

    const firstResult = await service.provisionWorkspaceMember(request);
    const secondResult = await service.provisionWorkspaceMember(request);

    expect(secondResult).toEqual(firstResult);
    expect(stores.users.size).toBe(1);
    expect(stores.userWorkspaces.size).toBe(1);
    expect(stores.workspaceMembers.size).toBe(1);
  });

  it('converges concurrent requests for the same workspace and email to one member', async () => {
    const { service, stores } = makeServiceHarness();
    const request = {
      workspaceId: WORKSPACE_ID,
      id: 'workos-user-5',
      email: 'ada@example.com',
      firstName: 'Ada',
      lastName: 'Lovelace',
    };

    const results = await Promise.all([
      service.provisionWorkspaceMember(request),
      service.provisionWorkspaceMember(request),
    ]);

    expect(results[0]).toEqual(results[1]);
    expect(stores.users.size).toBe(1);
    expect(stores.userWorkspaces.size).toBe(1);
    expect(stores.workspaceMembers.size).toBe(1);
  });

  it('throws not found when the workspace does not exist', async () => {
    const { service } = makeServiceHarness();

    await expect(
      service.provisionWorkspaceMember({
        workspaceId: '20202020-0000-4000-8000-000000000404',
        id: 'workos-user-6',
        email: 'ada@example.com',
        firstName: 'Ada',
        lastName: 'Lovelace',
      }),
    ).rejects.toThrow(NotFoundException);
  });

  it('throws bad request when the email is invalid', async () => {
    const { service } = makeServiceHarness();

    await expect(
      service.provisionWorkspaceMember({
        workspaceId: WORKSPACE_ID,
        id: 'workos-user-8',
        email: 'not-an-email',
        firstName: 'Ada',
        lastName: 'Lovelace',
      }),
    ).rejects.toThrow(BadRequestException);
  });

  it('throws conflict when an existing member belongs to a different core user', async () => {
    const { service, stores } = makeServiceHarness();

    stores.users.set('ada@example.com', {
      id: 'user-1',
      email: 'ada@example.com',
      firstName: 'Ada',
      lastName: 'Lovelace',
      isEmailVerified: true,
    });
    stores.workspaceMembers.set('ada@example.com', {
      id: 'workspace-member-conflict',
      userId: 'other-user-id',
      userEmail: 'ada@example.com',
      name: { firstName: 'Ada', lastName: 'Lovelace' },
    });

    await expect(
      service.provisionWorkspaceMember({
        workspaceId: WORKSPACE_ID,
        id: 'workos-user-7',
        email: 'ada@example.com',
        firstName: 'Ada',
        lastName: 'Lovelace',
      }),
    ).rejects.toThrow(ConflictException);
  });
});

describe('InternalWorkspaceMemberProvisioningService profile updates', () => {
  const input: UpdateWorkspaceMemberProfileInput = {
    workspaceId: WORKSPACE_ID,
    workspaceMemberId: 'workspace-member-existing',
    email: 'ada@example.com',
    firstName: 'Augusta',
    lastName: 'King',
    profilePolicy: 'provider',
  };

  const makeProfileHarness = () => {
    const harness = makeServiceHarness();
    const member: StoredWorkspaceMember = {
      id: input.workspaceMemberId,
      userId: 'original-core-user',
      userEmail: input.email,
      name: { firstName: 'Ada', lastName: 'Lovelace' },
    };

    harness.stores.workspaceMembers.set(member.userEmail, member);

    return { ...harness, member };
  };

  it('updates the linked member by ID without changing its core user or identity', async () => {
    const { service, stores, repositories, member, transactionScope } =
      makeProfileHarness();

    const result = await service.updateWorkspaceMemberProfile({
      ...input,
      email: '  AUGUSTA@Example.COM ',
    });

    expect(result).toEqual({
      workspaceMemberId: input.workspaceMemberId,
      workspaceId: WORKSPACE_ID,
    });
    expect(member).toEqual({
      id: input.workspaceMemberId,
      userId: 'original-core-user',
      userEmail: 'augusta@example.com',
      name: { firstName: 'Augusta', lastName: 'King' },
    });
    expect(stores.workspaceMembers.size).toBe(1);
    expect(stores.users.size).toBe(0);
    expect(stores.userWorkspaces.size).toBe(0);
    expect(repositories.userRepository.findOne).not.toHaveBeenCalled();
    expect(repositories.userRepository.save).not.toHaveBeenCalled();
    expect(repositories.userWorkspaceRepository.save).not.toHaveBeenCalled();
    expect(
      repositories.workspaceMemberRepository.insert,
    ).not.toHaveBeenCalled();
    expect(transactionScope.getRepository).toHaveBeenCalledWith(
      'workspaceMember',
      { shouldBypassPermissionChecks: true },
    );
    expect(transactionScope.executeRawQuery).toHaveBeenCalledWith(
      expect.stringMatching(
        /^LOCK TABLE "workspace_[a-z0-9]+"\."workspaceMember" IN SHARE ROW EXCLUSIVE MODE$/,
      ),
    );
  });

  it('does not write again for a repeated provider request', async () => {
    const { service, repositories } = makeProfileHarness();

    const firstResult = await service.updateWorkspaceMemberProfile(input);
    const secondResult = await service.updateWorkspaceMemberProfile(input);

    expect(secondResult).toEqual(firstResult);
    expect(repositories.workspaceMemberRepository.update).toHaveBeenCalledTimes(
      1,
    );
  });

  it('preserves names when the provider returns blank names', async () => {
    const { service, member, repositories } = makeProfileHarness();

    await service.updateWorkspaceMemberProfile({
      ...input,
      firstName: '   ',
      lastName: '',
    });

    expect(member.name).toEqual({ firstName: 'Ada', lastName: 'Lovelace' });
    expect(
      repositories.workspaceMemberRepository.update,
    ).not.toHaveBeenCalled();
  });

  it('trims nonempty provider names', async () => {
    const { service, member } = makeProfileHarness();

    await service.updateWorkspaceMemberProfile({
      ...input,
      firstName: '  Augusta ',
      lastName: ' King  ',
    });

    expect(member.name).toEqual({ firstName: 'Augusta', lastName: 'King' });
  });

  it('fills only blank Go names and preserves the Go email', async () => {
    const { service, member } = makeProfileHarness();

    member.name = { firstName: '   ', lastName: 'Go surname' };
    member.userEmail = 'ADA@Example.com';

    await service.updateWorkspaceMemberProfile({
      ...input,
      profilePolicy: 'fill_missing',
    });

    expect(member.name).toEqual({
      firstName: 'Augusta',
      lastName: 'Go surname',
    });
    expect(member.userEmail).toBe('ADA@Example.com');
  });

  it('does not overwrite nonempty Go names', async () => {
    const { service, member, repositories } = makeProfileHarness();

    await service.updateWorkspaceMemberProfile({
      ...input,
      profilePolicy: 'fill_missing',
    });

    expect(member.name).toEqual({ firstName: 'Ada', lastName: 'Lovelace' });
    expect(
      repositories.workspaceMemberRepository.update,
    ).not.toHaveBeenCalled();
  });

  it('leaves all profile fields unchanged when Go and provider emails differ', async () => {
    const { service, member, repositories } = makeProfileHarness();

    member.name = { firstName: '', lastName: '' };

    const result = await service.updateWorkspaceMemberProfile({
      ...input,
      email: 'different@example.com',
      profilePolicy: 'fill_missing',
    });

    expect(result.workspaceMemberId).toBe(member.id);
    expect(member.userEmail).toBe('ada@example.com');
    expect(member.name).toEqual({ firstName: '', lastName: '' });
    expect(
      repositories.workspaceMemberRepository.update,
    ).not.toHaveBeenCalled();
  });

  it('leaves all profile fields unchanged when a Go member has no email', async () => {
    const { service, member, repositories } = makeProfileHarness();

    member.userEmail = '';
    member.name = { firstName: '', lastName: '' };

    await service.updateWorkspaceMemberProfile({
      ...input,
      profilePolicy: 'fill_missing',
    });

    expect(member.userEmail).toBe('');
    expect(member.name).toEqual({ firstName: '', lastName: '' });
    expect(
      repositories.workspaceMemberRepository.update,
    ).not.toHaveBeenCalled();
  });

  it.each(['other@example.com', 'OTHER@EXAMPLE.COM', ' other@example.com '])(
    'rejects an email already held by another member: %s',
    async (existingEmail) => {
      const { service, stores, member, repositories } = makeProfileHarness();

      stores.workspaceMembers.set(existingEmail, {
        id: 'other-member',
        userId: 'other-user',
        userEmail: existingEmail,
        name: { firstName: 'Other', lastName: 'Member' },
      });

      await expect(
        service.updateWorkspaceMemberProfile({
          ...input,
          email: 'other@example.com',
        }),
      ).rejects.toThrow(ConflictException);
      expect(member).toMatchObject({
        userEmail: 'ada@example.com',
        name: { firstName: 'Ada', lastName: 'Lovelace' },
      });
      expect(
        repositories.workspaceMemberRepository.update,
      ).not.toHaveBeenCalled();
    },
  );

  it('returns not found without creating a missing member', async () => {
    const { service, repositories, stores } = makeProfileHarness();

    await expect(
      service.updateWorkspaceMemberProfile({
        ...input,
        workspaceMemberId: 'unknown-member',
      }),
    ).rejects.toThrow(NotFoundException);
    expect(stores.workspaceMembers.size).toBe(1);
    expect(
      repositories.workspaceMemberRepository.insert,
    ).not.toHaveBeenCalled();
    expect(
      repositories.workspaceMemberRepository.update,
    ).not.toHaveBeenCalled();
  });

  it('returns not found before entering another workspace context', async () => {
    const { service, globalWorkspaceOrmManager } = makeProfileHarness();

    await expect(
      service.updateWorkspaceMemberProfile({
        ...input,
        workspaceId: '20202020-0000-4000-8000-000000000404',
      }),
    ).rejects.toThrow(NotFoundException);
    expect(
      globalWorkspaceOrmManager.executeInWorkspaceContext,
    ).not.toHaveBeenCalled();
  });

  it('rejects invalid email before opening a workspace transaction', async () => {
    const { service, globalWorkspaceOrmManager } = makeProfileHarness();

    await expect(
      service.updateWorkspaceMemberProfile({ ...input, email: 'not-an-email' }),
    ).rejects.toThrow(BadRequestException);
    expect(
      globalWorkspaceOrmManager.runInWorkspaceTransaction,
    ).not.toHaveBeenCalled();
  });

  it('retains a completed Go name fill when a second fill follows it', async () => {
    const { service, member } = makeProfileHarness();

    member.name = { firstName: '', lastName: '' };

    await Promise.all([
      service.updateWorkspaceMemberProfile({
        ...input,
        firstName: 'First',
        lastName: 'Fill',
        profilePolicy: 'fill_missing',
      }),
      service.updateWorkspaceMemberProfile({
        ...input,
        firstName: 'Second',
        lastName: 'Fill',
        profilePolicy: 'fill_missing',
      }),
    ]);

    expect(member.name).toEqual({ firstName: 'First', lastName: 'Fill' });
  });

  it('allows only one member to claim the same email in competing updates', async () => {
    const { service, stores } = makeProfileHarness();

    stores.workspaceMembers.set('other@example.com', {
      id: 'other-member',
      userId: 'other-user',
      userEmail: 'other@example.com',
      name: { firstName: 'Other', lastName: 'Member' },
    });

    const results = await Promise.allSettled([
      service.updateWorkspaceMemberProfile({
        ...input,
        email: 'shared@example.com',
      }),
      service.updateWorkspaceMemberProfile({
        ...input,
        workspaceMemberId: 'other-member',
        email: 'SHARED@example.com',
      }),
    ]);

    expect(results.map((result) => result.status).sort()).toEqual([
      'fulfilled',
      'rejected',
    ]);
    const failure = results.find((result) => result.status === 'rejected');

    expect(failure?.status === 'rejected' && failure.reason).toBeInstanceOf(
      ConflictException,
    );
    expect(
      Array.from(stores.workspaceMembers.values()).filter(
        (member) => member.userEmail === 'shared@example.com',
      ),
    ).toHaveLength(1);
  });

  it('propagates a lock failure without reading or changing a member', async () => {
    const { service, repositories, transactionScope } = makeProfileHarness();
    const failure = new Error('lock timeout');

    transactionScope.executeRawQuery
      .mockResolvedValueOnce([])
      .mockRejectedValueOnce(failure);

    await expect(service.updateWorkspaceMemberProfile(input)).rejects.toBe(
      failure,
    );
    expect(
      repositories.workspaceMemberRepository.findOne,
    ).not.toHaveBeenCalled();
    expect(
      repositories.workspaceMemberRepository.update,
    ).not.toHaveBeenCalled();
  });

  it('propagates a failed write for the directory worker to retry', async () => {
    const { service, repositories, member } = makeProfileHarness();
    const failure = new Error('database write failed');

    repositories.workspaceMemberRepository.update.mockRejectedValueOnce(
      failure,
    );

    await expect(service.updateWorkspaceMemberProfile(input)).rejects.toBe(
      failure,
    );
    expect(member.name).toEqual({ firstName: 'Ada', lastName: 'Lovelace' });
  });
});
