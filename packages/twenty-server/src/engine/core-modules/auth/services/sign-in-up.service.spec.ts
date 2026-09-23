import { WorkspaceActivationStatus } from 'twenty-shared/workspace';
import { QueryFailedError } from 'typeorm';

import {
  AuthException,
  AuthExceptionCode,
} from 'src/engine/core-modules/auth/auth.exception';
import { type SignInUpNewUserPayload } from 'src/engine/core-modules/auth/types/signInUp.type';
import { DpaAgreementEntity } from 'src/engine/core-modules/dpa/entities/dpa-agreement.entity';
import { AuthProviderEnum } from 'src/engine/core-modules/workspace/types/workspace.type';
import { UserEntity } from 'src/engine/core-modules/user/user.entity';
import { WorkspaceExceptionCode } from 'src/engine/core-modules/workspace/workspace.exception';

import { SignInUpService } from './sign-in-up.service';

jest.mock(
  'src/engine/core-modules/user-workspace/user-workspace.service',
  () => ({ UserWorkspaceService: class {} }),
);
jest.mock('src/engine/core-modules/application/application.service', () => ({
  ApplicationService: class {},
}));
jest.mock(
  'src/engine/core-modules/billing/services/billing-credit.service',
  () => ({ BillingCreditService: class {} }),
);
jest.mock('src/engine/core-modules/billing/services/billing.service', () => ({
  BillingService: class {},
}));
jest.mock(
  'src/engine/core-modules/workspace-invitation/services/workspace-invitation.service',
  () => ({ WorkspaceInvitationService: class {} }),
);
jest.mock('src/engine/core-modules/user/services/user.service', () => ({
  UserService: class {},
}));
jest.mock(
  'src/engine/core-modules/file/file-core-picture/services/file-core-picture.service',
  () => ({ FileCorePictureService: class {} }),
);
jest.mock(
  'src/engine/workspace-cache/services/workspace-cache.service',
  () => ({ WorkspaceCacheService: class {} }),
);
jest.mock(
  'src/engine/core-modules/twenty-config/twenty-config.service',
  () => ({ TwentyConfigService: class {} }),
);
jest.mock(
  'src/engine/core-modules/domain/subdomain-manager/services/subdomain-manager.service',
  () => ({ SubdomainManagerService: class {} }),
);
jest.mock(
  'src/engine/core-modules/enterprise/services/enterprise-plan.service',
  () => ({ EnterprisePlanService: class {} }),
);
jest.mock('src/engine/core-modules/onboarding/onboarding.service', () => ({
  OnboardingService: class {},
}));
jest.mock('src/engine/core-modules/metrics/metrics.service', () => ({
  MetricsService: class {},
}));
jest.mock('src/engine/workspace-event-emitter/workspace-event-emitter', () => ({
  WorkspaceEventEmitter: class {},
}));
jest.mock(
  'src/engine/core-modules/event-logs/emit/event-log-emitter.service',
  () => ({ EventLogEmitterService: class {} }),
);

const mockPartialUserPayload: SignInUpNewUserPayload = {
  email: 'first.user@acme.dev',
  firstName: 'First',
  lastName: 'User',
  locale: 'en',
  isEmailAlreadyVerified: true,
};

type MockConfigurationValues = {
  IS_MULTIWORKSPACE_ENABLED: boolean;
  IS_WORKSPACE_CREATION_LIMITED_TO_SERVER_ADMINS: boolean;
  SERVER_URL: string;
};

const createSignInUpServiceForTests = () => {
  const mockUserRepository = {
    create: jest.fn((user) => user),
    save: jest.fn(async (user) => ({ id: 'saved-user-id', ...user })),
    count: jest.fn(),
  };

  const mockWorkspaceRepository = {
    count: jest.fn(),
    create: jest.fn((workspace) => workspace),
  };

  const mockApplicationService = {
    createWorkspaceCustomApplication: jest.fn().mockResolvedValue({
      universalIdentifier: 'application-universal-identifier',
    }),
  };

  const mockConfigurationValues: MockConfigurationValues = {
    IS_MULTIWORKSPACE_ENABLED: true,
    IS_WORKSPACE_CREATION_LIMITED_TO_SERVER_ADMINS: false,
    SERVER_URL: 'http://localhost:3000',
  };

  const mockTwentyConfigService = {
    get: jest.fn(
      (configKey: keyof MockConfigurationValues) =>
        mockConfigurationValues[configKey],
    ),
  };

  const queryRunnerMock = {
    manager: {
      save: jest.fn((_entity, entity) => entity),
      update: jest.fn(),
    },
    connect: jest.fn(),
    startTransaction: jest.fn(),
    commitTransaction: jest.fn(),
    rollbackTransaction: jest.fn(),
    release: jest.fn(),
  };

  const mockUserWorkspaceService = {
    create: jest.fn(),
    checkUserWorkspaceExists: jest.fn(),
    addUserToWorkspaceIfUserNotInWorkspace: jest.fn(),
  };

  const mockOnboardingService = {
    setOnboardingConnectAccountPending: jest.fn(),
    setOnboardingCreateProfilePending: jest.fn(),
    setOnboardingInstallAppsPending: jest.fn(),
    setOnboardingInviteTeamPending: jest.fn(),
    createOnboardingStatusForWorkspaceMember: jest.fn(),
  };
  const mockUserService = {
    findUserByEmail: jest.fn(),
    findByEmail: jest.fn(),
    markEmailAsVerified: jest.fn(),
  };
  const mockBillingService = {
    isBillingEnabled: jest.fn(),
    ensureBillingCustomer: jest.fn(),
  };
  const mockDataSource = {
    createQueryRunner: jest.fn(() => queryRunnerMock),
    transaction: jest.fn(async (runInTransaction) =>
      runInTransaction({ queryRunner: queryRunnerMock }),
    ),
  };

  const service = new SignInUpService(
    mockUserRepository as any,
    mockWorkspaceRepository as any,
    {
      validatePersonalInvitation: jest.fn(),
      invalidateWorkspaceInvitation: jest.fn(),
    } as any,
    mockUserWorkspaceService as any,
    mockOnboardingService as any,
    {
      emitCustomBatchEvent: jest.fn(),
    } as any,
    mockTwentyConfigService as any,
    {
      generateSubdomain: jest.fn(),
      validateSubdomainOrThrow: jest.fn(),
    } as any,
    mockUserService as never,
    {
      incrementCounterForEvent: jest.fn(),
    } as any,
    {
      invalidateAndRecompute: jest.fn(),
    } as any,
    mockApplicationService as any,
    {
      uploadWorkspaceLogoFromUrl: jest.fn(),
    } as any,
    {
      isValid: jest.fn().mockReturnValue(false),
    } as any,
    {
      createContext: jest.fn().mockReturnValue({
        insertWorkspaceEvent: jest.fn(),
      }),
    } as any,
    {
      creditWorkspaceBalance: jest.fn(),
    } as any,
    mockBillingService as never,
    mockDataSource as never,
  );

  return {
    service,
    mockUserRepository,
    mockWorkspaceRepository,
    mockConfigurationValues,
    mockUserWorkspaceService,
    mockApplicationService,
    mockOnboardingService,
    queryRunnerMock,
    mockUserService,
    mockBillingService,
    mockDataSource,
  };
};

describe('SignInUpService concurrent internal provisioning', () => {
  const newUserWithPicture = {
    email: 'twenty-workspace-provisioning@regie.ai',
    firstName: 'Regie',
    lastName: 'Provisioning',
    isEmailVerified: true,
  };
  const userData = { type: 'newUserWithPicture' as const, newUserWithPicture };
  const options = {
    displayName: 'Internal workspace',
    subdomain: 'internal-one',
    shouldBypassWorkspaceCreationChecks: true,
    shouldRecordDpaAcceptance: false,
  };
  const databaseError = (code = '23505', constraint = 'UQ_USER_EMAIL') =>
    new QueryFailedError(
      'INSERT',
      [],
      Object.assign(new Error('injected database error'), { code, constraint }),
    );

  it('allows concurrent workspaces to share the user created by the winning transaction', async () => {
    const {
      service,
      queryRunnerMock,
      mockUserService,
      mockDataSource,
      mockUserWorkspaceService,
    } = createSignInUpServiceForTests();
    let storedUser: { id: string; email: string } | undefined;
    queryRunnerMock.manager.save.mockImplementation(async (entity, value) => {
      if (entity !== UserEntity) return value;
      await Promise.resolve();
      if (storedUser) throw databaseError();
      storedUser = { ...value, id: 'shared-service-user' };
      return storedUser;
    });
    mockUserService.findUserByEmail.mockImplementation(async (email: string) =>
      email === storedUser?.email ? storedUser : null,
    );

    const [first, second] = await Promise.all([
      service.signUpOnNewWorkspace(userData, options),
      service.signUpOnNewWorkspace(userData, {
        ...options,
        subdomain: 'internal-two',
      }),
    ]);

    expect(first.user.id).toBe('shared-service-user');
    expect(second.user.id).toBe(first.user.id);
    expect(first.workspace.id).not.toBe(second.workspace.id);
    expect([first.workspace.subdomain, second.workspace.subdomain]).toEqual([
      'internal-one',
      'internal-two',
    ]);
    expect(mockDataSource.transaction).toHaveBeenCalledTimes(3);
    expect(mockUserService.findUserByEmail).toHaveBeenCalledTimes(1);
    expect(mockUserService.findUserByEmail).toHaveBeenCalledWith(
      newUserWithPicture.email,
    );
    expect(
      mockUserWorkspaceService.create.mock.calls.map(([input]) => input.userId),
    ).toEqual(['shared-service-user', 'shared-service-user']);
    expect(
      mockUserWorkspaceService.create.mock.calls.map(
        ([input]) => input.isExistingUser,
      ),
    ).toEqual([false, true]);
  });

  it('looks up the normalized exact email and propagates the race if the user is unavailable', async () => {
    const { service, mockUserService, mockDataSource } =
      createSignInUpServiceForTests();
    const failure = databaseError();
    mockDataSource.transaction.mockRejectedValue(failure);
    mockUserService.findUserByEmail.mockResolvedValue(null);

    await expect(
      service.signUpOnNewWorkspace(
        {
          ...userData,
          newUserWithPicture: {
            ...newUserWithPicture,
            email: ' Service@REGIE.AI ',
          },
        },
        options,
      ),
    ).rejects.toBe(failure);
    expect(mockUserService.findUserByEmail).toHaveBeenCalledWith(
      'service@regie.ai',
    );
    expect(mockDataSource.transaction).toHaveBeenCalledTimes(1);
  });

  it('does not adopt an existing identity during public signup', async () => {
    const {
      service,
      mockUserService,
      mockDataSource,
      mockWorkspaceRepository,
    } = createSignInUpServiceForTests();
    mockWorkspaceRepository.count.mockResolvedValue(0);
    mockDataSource.transaction.mockRejectedValue(databaseError());

    await expect(
      service.signUpOnNewWorkspace(userData, {
        ...options,
        shouldBypassWorkspaceCreationChecks: false,
      }),
    ).rejects.toMatchObject({
      code: WorkspaceExceptionCode.SUBDOMAIN_ALREADY_TAKEN,
    });
    expect(mockUserService.findUserByEmail).not.toHaveBeenCalled();
    expect(mockDataSource.transaction).toHaveBeenCalledTimes(1);
  });

  it('preserves unrelated uniqueness conflicts without looking up or retrying the user', async () => {
    const { service, mockUserService, mockDataSource } =
      createSignInUpServiceForTests();
    mockDataSource.transaction.mockRejectedValue(
      databaseError('23505', 'UQ_WORKSPACE_SUBDOMAIN'),
    );

    await expect(
      service.signUpOnNewWorkspace(userData, options),
    ).rejects.toMatchObject({
      code: WorkspaceExceptionCode.SUBDOMAIN_ALREADY_TAKEN,
    });
    expect(mockUserService.findUserByEmail).not.toHaveBeenCalled();
    expect(mockDataSource.transaction).toHaveBeenCalledTimes(1);
  });

  it('propagates unexpected database errors unchanged', async () => {
    const { service, mockUserService, mockDataSource } =
      createSignInUpServiceForTests();
    const failure = databaseError('40001');
    mockDataSource.transaction.mockRejectedValue(failure);

    await expect(service.signUpOnNewWorkspace(userData, options)).rejects.toBe(
      failure,
    );
    expect(mockUserService.findUserByEmail).not.toHaveBeenCalled();
    expect(mockDataSource.transaction).toHaveBeenCalledTimes(1);
  });

  it('never repeats a committed workspace after a later billing error', async () => {
    const { service, mockUserService, mockDataSource, mockBillingService } =
      createSignInUpServiceForTests();
    mockBillingService.isBillingEnabled.mockReturnValue(true);
    mockBillingService.ensureBillingCustomer.mockRejectedValue(databaseError());

    await expect(
      service.signUpOnNewWorkspace(userData, options),
    ).rejects.toMatchObject({
      code: WorkspaceExceptionCode.SUBDOMAIN_ALREADY_TAKEN,
    });
    expect(mockUserService.findUserByEmail).not.toHaveBeenCalled();
    expect(mockDataSource.transaction).toHaveBeenCalledTimes(1);
  });

  it('does not retry a second failure on the existing-user path', async () => {
    const { service, mockUserService, mockDataSource } =
      createSignInUpServiceForTests();
    mockDataSource.transaction.mockRejectedValue(databaseError());
    mockUserService.findUserByEmail.mockResolvedValue({
      ...newUserWithPicture,
      id: 'shared-user',
    });

    await expect(
      service.signUpOnNewWorkspace(userData, options),
    ).rejects.toMatchObject({
      code: WorkspaceExceptionCode.SUBDOMAIN_ALREADY_TAKEN,
    });
    expect(mockUserService.findUserByEmail).toHaveBeenCalledTimes(1);
    expect(mockDataSource.transaction).toHaveBeenCalledTimes(2);
  });
});

describe('SignInUpService workspace-creation policy', () => {
  it('grants bootstrap owner server permissions when multi-workspace is enabled and unrestricted', async () => {
    const {
      service,
      mockUserRepository,
      mockWorkspaceRepository,
      mockConfigurationValues,
    } = createSignInUpServiceForTests();

    mockConfigurationValues.IS_MULTIWORKSPACE_ENABLED = true;
    mockConfigurationValues.IS_WORKSPACE_CREATION_LIMITED_TO_SERVER_ADMINS = false;
    mockWorkspaceRepository.count.mockResolvedValue(0);
    mockUserRepository.count.mockResolvedValue(0);
    jest
      .spyOn((service as any).userService, 'findUserByEmail')
      .mockResolvedValue(null);

    await service.signUpWithoutWorkspace(mockPartialUserPayload, {
      provider: AuthProviderEnum.Google,
    } as any);

    expect(mockUserRepository.create).toHaveBeenCalledWith(
      expect.objectContaining({
        canImpersonate: true,
        canAccessFullAdminPanel: true,
      }),
    );
  });

  it('grants bootstrap owner server permissions when multi-workspace is enabled and restricted', async () => {
    const {
      service,
      mockUserRepository,
      mockWorkspaceRepository,
      mockConfigurationValues,
    } = createSignInUpServiceForTests();

    mockConfigurationValues.IS_MULTIWORKSPACE_ENABLED = true;
    mockConfigurationValues.IS_WORKSPACE_CREATION_LIMITED_TO_SERVER_ADMINS = true;
    mockWorkspaceRepository.count.mockResolvedValue(0);
    mockUserRepository.count.mockResolvedValue(0);
    jest
      .spyOn((service as any).userService, 'findUserByEmail')
      .mockResolvedValue(null);

    await service.signUpWithoutWorkspace(mockPartialUserPayload, {
      provider: AuthProviderEnum.Google,
    } as any);

    expect(mockUserRepository.create).toHaveBeenCalledWith(
      expect.objectContaining({
        canImpersonate: true,
        canAccessFullAdminPanel: true,
      }),
    );
  });

  it('assigns default non-admin permissions after bootstrap in multi-workspace mode', async () => {
    const {
      service,
      mockUserRepository,
      mockWorkspaceRepository,
      mockConfigurationValues,
    } = createSignInUpServiceForTests();

    mockConfigurationValues.IS_MULTIWORKSPACE_ENABLED = true;
    mockConfigurationValues.IS_WORKSPACE_CREATION_LIMITED_TO_SERVER_ADMINS = false;
    mockWorkspaceRepository.count.mockResolvedValue(1);
    mockUserRepository.count.mockResolvedValue(1);
    jest
      .spyOn((service as any).userService, 'findUserByEmail')
      .mockResolvedValue(null);

    await service.signUpWithoutWorkspace(mockPartialUserPayload, {
      provider: AuthProviderEnum.Google,
    } as any);

    expect(mockUserRepository.create).toHaveBeenCalledWith(
      expect.objectContaining({
        canImpersonate: false,
        canAccessFullAdminPanel: false,
      }),
    );
  });

  it('does not grant admin to second user signing up before any workspace exists', async () => {
    const {
      service,
      mockUserRepository,
      mockWorkspaceRepository,
      mockConfigurationValues,
    } = createSignInUpServiceForTests();

    mockConfigurationValues.IS_MULTIWORKSPACE_ENABLED = true;
    mockConfigurationValues.IS_WORKSPACE_CREATION_LIMITED_TO_SERVER_ADMINS = false;
    mockWorkspaceRepository.count.mockResolvedValue(0);
    mockUserRepository.count.mockResolvedValue(1);
    jest
      .spyOn((service as any).userService, 'findUserByEmail')
      .mockResolvedValue(null);

    await service.signUpWithoutWorkspace(mockPartialUserPayload, {
      provider: AuthProviderEnum.Google,
    } as any);

    expect(mockUserRepository.create).toHaveBeenCalledWith(
      expect.objectContaining({
        canImpersonate: false,
        canAccessFullAdminPanel: false,
      }),
    );
  });

  it('throws forbidden when a non-admin existing user creates workspace in restricted mode after bootstrap', async () => {
    const { service, mockWorkspaceRepository, mockConfigurationValues } =
      createSignInUpServiceForTests();

    mockConfigurationValues.IS_MULTIWORKSPACE_ENABLED = true;
    mockConfigurationValues.IS_WORKSPACE_CREATION_LIMITED_TO_SERVER_ADMINS = true;
    mockWorkspaceRepository.count.mockResolvedValue(1);

    const nonAdminExistingUser = {
      id: 'existing-user-id',
      email: 'existing.user@acme.dev',
      canAccessFullAdminPanel: false,
    };

    await expect(
      service.signUpOnNewWorkspace({
        type: 'existingUser',
        existingUser: nonAdminExistingUser as any,
      }),
    ).rejects.toMatchObject({
      code: AuthExceptionCode.FORBIDDEN_EXCEPTION,
    });
  });

  it('throws SIGNUP_DISABLED when creating workspace in single-workspace mode after bootstrap', async () => {
    const { service, mockWorkspaceRepository, mockConfigurationValues } =
      createSignInUpServiceForTests();

    mockConfigurationValues.IS_MULTIWORKSPACE_ENABLED = false;
    mockConfigurationValues.IS_WORKSPACE_CREATION_LIMITED_TO_SERVER_ADMINS = false;
    mockWorkspaceRepository.count.mockResolvedValue(1);

    await expect(
      service.signUpOnNewWorkspace({
        type: 'existingUser',
        existingUser: {
          id: 'existing-user-id',
          email: 'existing.user@acme.dev',
          canAccessFullAdminPanel: true,
        } as any,
      }),
    ).rejects.toMatchObject({
      code: AuthExceptionCode.SIGNUP_DISABLED,
    });
  });

  it('keeps single-workspace SIGNUP_DISABLED behavior after first workspace exists', async () => {
    const { service, mockWorkspaceRepository, mockConfigurationValues } =
      createSignInUpServiceForTests();

    mockConfigurationValues.IS_MULTIWORKSPACE_ENABLED = false;
    mockConfigurationValues.IS_WORKSPACE_CREATION_LIMITED_TO_SERVER_ADMINS = false;
    mockWorkspaceRepository.count.mockResolvedValue(1);
    jest
      .spyOn((service as any).userService, 'findUserByEmail')
      .mockResolvedValue(null);

    await expect(
      service.signUpWithoutWorkspace(mockPartialUserPayload, {
        provider: AuthProviderEnum.Google,
      } as any),
    ).rejects.toBeInstanceOf(AuthException);

    await expect(
      service.signUpWithoutWorkspace(mockPartialUserPayload, {
        provider: AuthProviderEnum.Google,
      } as any),
    ).rejects.toMatchObject({
      code: AuthExceptionCode.SIGNUP_DISABLED,
    });
  });

  it('allows internal provisioning to bypass public workspace creation limits', async () => {
    const {
      service,
      mockWorkspaceRepository,
      mockUserWorkspaceService,
      mockApplicationService,
      mockOnboardingService,
      queryRunnerMock,
    } = createSignInUpServiceForTests();

    const existingUser = {
      id: 'existing-user-id',
      email: 'existing.user@gmail.com',
      canAccessFullAdminPanel: false,
      firstName: 'Existing',
      lastName: 'User',
    };

    mockWorkspaceRepository.count.mockResolvedValue(5);

    const result = await service.signUpOnNewWorkspace(
      {
        type: 'existingUser',
        existingUser: existingUser as any,
      },
      {
        displayName: 'Acme',
        subdomain: 'acme',
        shouldBypassWorkspaceCreationChecks: true,
        shouldRecordDpaAcceptance: false,
      },
    );

    expect(result.user).toBe(existingUser);
    expect(result.workspace).toEqual(
      expect.objectContaining({
        displayName: 'Acme',
        subdomain: 'acme',
      }),
    );
    expect(
      mockApplicationService.createWorkspaceCustomApplication,
    ).toHaveBeenCalled();
    expect(mockUserWorkspaceService.create).toHaveBeenCalledWith(
      expect.objectContaining({
        userId: existingUser.id,
        isExistingUser: true,
      }),
      expect.any(Object),
    );
    expect(
      mockOnboardingService.setOnboardingConnectAccountPending,
    ).toHaveBeenCalled();
    expect(queryRunnerMock.manager.save).not.toHaveBeenCalledWith(
      DpaAgreementEntity,
      expect.anything(),
    );
  });

  it('records DPA acceptance for normal multi-workspace signup', async () => {
    const {
      service,
      mockWorkspaceRepository,
      mockUserRepository,
      queryRunnerMock,
    } = createSignInUpServiceForTests();

    mockWorkspaceRepository.count.mockResolvedValue(0);
    mockUserRepository.count.mockResolvedValue(0);

    await service.signUpOnNewWorkspace(
      {
        type: 'newUserWithPicture',
        newUserWithPicture: {
          email: 'creator@gmail.com',
          firstName: 'Creator',
          lastName: 'User',
        },
      },
      { displayName: 'Acme Inc' },
    );

    expect(queryRunnerMock.manager.save).toHaveBeenCalledWith(
      DpaAgreementEntity,
      expect.objectContaining({
        acceptedByEmail: 'creator@gmail.com',
      }),
    );
  });
});

describe('SignInUpService onboarding steps', () => {
  it('flags the connect-account step but not the install-apps step for a new user joining an existing workspace', async () => {
    const { service, mockOnboardingService } = createSignInUpServiceForTests();

    await service.signInUpOnExistingWorkspace({
      workspace: {
        id: 'existing-workspace-id',
        activationStatus: WorkspaceActivationStatus.ACTIVE,
      } as any,
      userData: {
        type: 'newUserWithPicture',
        newUserWithPicture: {
          email: 'invited.user@acme.dev',
          firstName: 'Invited',
          lastName: 'User',
        },
      },
    });

    expect(
      mockOnboardingService.setOnboardingCreateProfilePending,
    ).toHaveBeenCalledWith(expect.objectContaining({ value: true }), undefined);
    expect(
      mockOnboardingService.setOnboardingInstallAppsPending,
    ).not.toHaveBeenCalled();
    expect(
      mockOnboardingService.setOnboardingConnectAccountPending,
    ).toHaveBeenCalledWith(expect.objectContaining({ value: true }), undefined);
  });

  it('flags the install-apps step for a user creating a new workspace', async () => {
    const {
      service,
      mockOnboardingService,
      mockWorkspaceRepository,
      mockUserRepository,
    } = createSignInUpServiceForTests();

    mockWorkspaceRepository.count.mockResolvedValue(0);
    mockUserRepository.count.mockResolvedValue(0);

    await service.signUpOnNewWorkspace(
      {
        type: 'newUserWithPicture',
        newUserWithPicture: {
          email: 'creator@gmail.com',
          firstName: 'Creator',
          lastName: 'User',
        },
      },
      { displayName: 'Acme Inc' },
    );

    expect(
      mockOnboardingService.setOnboardingInstallAppsPending,
    ).toHaveBeenCalledWith(
      expect.objectContaining({ value: true }),
      expect.anything(),
    );
  });
});
