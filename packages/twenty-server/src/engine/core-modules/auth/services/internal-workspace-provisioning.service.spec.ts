import { BadRequestException, NotFoundException } from '@nestjs/common';

import { InternalWorkspaceProvisioningService } from 'src/engine/core-modules/auth/services/internal-workspace-provisioning.service';

describe('InternalWorkspaceProvisioningService', () => {
  const workspace = {
    id: '20202020-0000-4000-8000-000000000001',
    displayName: 'Acme',
    subdomain: 'acme',
  };
  const user = {
    id: 'user-id',
    email: 'twenty-workspace-provisioning@regie.ai',
    firstName: 'Regie',
    lastName: 'Provisioning',
    isEmailVerified: true,
    disabled: false,
    canImpersonate: false,
    canAccessFullAdminPanel: false,
    locale: 'en',
    createdAt: new Date('2026-01-01T00:00:00.000Z'),
    updatedAt: new Date('2026-01-01T00:00:00.000Z'),
    deletedAt: null,
  };
  const flatUser = {
    ...user,
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
    deletedAt: undefined,
  };
  const e2eWorkspace = {
    ...workspace,
    subdomain: 'org-e2e-run-1',
  };

  const makeService = () => {
    const signInUpService = {
      signUpOnNewWorkspace: jest.fn().mockResolvedValue({ user, workspace }),
    };
    const userService = {
      findUserByEmail: jest.fn().mockResolvedValue(user),
    };
    const workspaceService = {
      activateWorkspace: jest.fn().mockResolvedValue({
        ...workspace,
        displayName: 'Acme Activated',
      }),
      findOneWorkspaceById: jest.fn().mockResolvedValue(workspace),
      findOneWorkspaceByIdIncludingDeleted: jest
        .fn()
        .mockResolvedValue(workspace),
      deleteWorkspace: jest.fn().mockResolvedValue(workspace),
    };
    const apiKeyService = {
      createWorkspaceAdminApiKeyToken: jest.fn().mockResolvedValue({
        apiKeyId: 'api-key-id',
        token: 'api-key-token',
      }),
    };
    const keyValuePairService = {
      set: jest.fn(),
      get: jest.fn().mockResolvedValue([
        {
          value: {
            ephemeral: true,
            organizationId: 'org_e2e_run_1',
            workspaceSlug: e2eWorkspace.subdomain,
          },
        },
      ]),
    };

    const service = new InternalWorkspaceProvisioningService(
      signInUpService as any,
      userService as any,
      workspaceService as any,
      apiKeyService as any,
      keyValuePairService as any,
    );

    return {
      service,
      signInUpService,
      userService,
      workspaceService,
      apiKeyService,
      keyValuePairService,
    };
  };

  it('creates and activates a workspace with the reusable service user', async () => {
    const { service, signInUpService, userService, workspaceService } =
      makeService();

    const result = await service.createWorkspace({
      name: ' Acme ',
      slug: ' acme ',
      primaryDomain: 'https://crm.acme.test',
      serviceUserEmail: ' Provisioning@REGIE.AI ',
    });

    expect(userService.findUserByEmail).toHaveBeenCalledWith(
      'provisioning@regie.ai',
    );
    expect(signInUpService.signUpOnNewWorkspace).toHaveBeenCalledWith(
      {
        type: 'existingUser',
        existingUser: user,
      },
      {
        displayName: 'Acme',
        subdomain: 'acme',
        shouldBypassWorkspaceCreationChecks: true,
        shouldRecordDpaAcceptance: false,
      },
    );
    expect(workspaceService.activateWorkspace).toHaveBeenCalledWith(
      flatUser,
      workspace,
    );
    expect(result).toEqual({
      ok: true,
      id: workspace.id,
      workspaceId: workspace.id,
      workspaceUrl: 'https://crm.acme.test',
      workspaceName: 'Acme Activated',
      workspaceSubdomain: 'acme',
    });
  });

  it('persists the E2E marker before activating an ephemeral workspace', async () => {
    const { service, signInUpService, workspaceService, keyValuePairService } =
      makeService();

    signInUpService.signUpOnNewWorkspace.mockResolvedValue({
      user,
      workspace: e2eWorkspace,
    });
    workspaceService.activateWorkspace.mockResolvedValue(e2eWorkspace);

    await service.createWorkspace({
      name: 'E2E run',
      slug: e2eWorkspace.subdomain,
      ephemeral: true,
      organizationId: 'org_e2e_run_1',
    });

    expect(keyValuePairService.set).toHaveBeenCalledWith({
      workspaceId: e2eWorkspace.id,
      key: 'regie-internal:e2e-workspace-marker',
      value: {
        ephemeral: true,
        organizationId: 'org_e2e_run_1',
        workspaceSlug: e2eWorkspace.subdomain,
      },
      type: 'USER_VARIABLE',
    });
    expect(keyValuePairService.set.mock.invocationCallOrder[0]).toBeLessThan(
      workspaceService.activateWorkspace.mock.invocationCallOrder[0],
    );
  });

  it('rejects an ephemeral marker without matching E2E identifiers', async () => {
    const { service } = makeService();

    await expect(
      service.createWorkspace({
        name: 'Acme',
        slug: 'acme',
        ephemeral: true,
        organizationId: 'org_acme',
      }),
    ).rejects.toThrow(BadRequestException);
  });

  it('creates the service user through signup when missing', async () => {
    const { service, signInUpService, userService } = makeService();

    userService.findUserByEmail.mockResolvedValue(null);

    await service.createWorkspace({
      name: 'Acme',
      slug: 'acme',
    });

    expect(signInUpService.signUpOnNewWorkspace).toHaveBeenCalledWith(
      {
        type: 'newUserWithPicture',
        newUserWithPicture: {
          email: 'twenty-workspace-provisioning@regie.ai',
          firstName: 'Regie',
          lastName: 'Provisioning',
          isEmailVerified: true,
        },
      },
      {
        displayName: 'Acme',
        subdomain: 'acme',
        shouldBypassWorkspaceCreationChecks: true,
        shouldRecordDpaAcceptance: false,
      },
    );
  });

  it('rejects missing workspace creation fields', async () => {
    const { service } = makeService();

    await expect(
      service.createWorkspace({
        name: ' ',
        slug: 'acme',
      }),
    ).rejects.toThrow(BadRequestException);
  });

  it('activates an existing workspace with the service user', async () => {
    const { service, userService, workspaceService } = makeService();

    const result = await service.activateWorkspace(workspace.id);

    expect(userService.findUserByEmail).toHaveBeenCalledWith(
      'twenty-workspace-provisioning@regie.ai',
    );
    expect(workspaceService.findOneWorkspaceById).toHaveBeenCalledWith(
      workspace.id,
    );
    expect(workspaceService.activateWorkspace).toHaveBeenCalledWith(
      flatUser,
      workspace,
    );
    expect(result.workspaceId).toBe(workspace.id);
  });

  it('throws when activating a missing workspace', async () => {
    const { service, workspaceService } = makeService();

    workspaceService.findOneWorkspaceById.mockResolvedValue(null);

    await expect(service.activateWorkspace(workspace.id)).rejects.toThrow(
      NotFoundException,
    );
  });

  it('creates a workspace admin API key', async () => {
    const { service, apiKeyService, workspaceService } = makeService();

    const result = await service.createWorkspaceApiKey(workspace.id, {
      name: ' regie-crm-api ',
      expiresAt: '2030-01-01T00:00:00.000Z',
    });

    expect(workspaceService.findOneWorkspaceById).toHaveBeenCalledWith(
      workspace.id,
    );
    expect(apiKeyService.createWorkspaceAdminApiKeyToken).toHaveBeenCalledWith({
      workspaceId: workspace.id,
      name: 'regie-crm-api',
      expiresAt: '2030-01-01T00:00:00.000Z',
    });
    expect(result).toEqual({
      ok: true,
      workspaceId: workspace.id,
      apiKey: 'api-key-token',
      apiKeyId: 'api-key-id',
    });
  });

  it('quarantines a persistently marked E2E workspace', async () => {
    const { service, workspaceService } = makeService();

    workspaceService.findOneWorkspaceByIdIncludingDeleted.mockResolvedValue(
      e2eWorkspace,
    );

    const result = await service.deleteWorkspace(e2eWorkspace.id);

    expect(
      workspaceService.findOneWorkspaceByIdIncludingDeleted,
    ).toHaveBeenCalledWith(e2eWorkspace.id);
    expect(workspaceService.deleteWorkspace).toHaveBeenCalledWith(
      e2eWorkspace.id,
      true,
    );
    expect(result).toMatchObject({
      ok: true,
      id: e2eWorkspace.id,
      workspaceId: e2eWorkspace.id,
      deleted: true,
      quarantined: true,
      purgeEligible: true,
    });
    expect(result.purgeAfter).toBeDefined();
  });

  it('idempotently re-quarantines a previously soft-deleted workspace', async () => {
    const { service, workspaceService } = makeService();
    const softDeletedWorkspace = {
      ...e2eWorkspace,
      deletedAt: new Date('2026-09-01T00:00:00.000Z'),
    };

    workspaceService.findOneWorkspaceByIdIncludingDeleted.mockResolvedValue(
      softDeletedWorkspace,
    );
    workspaceService.deleteWorkspace.mockResolvedValue(softDeletedWorkspace);

    await expect(
      service.deleteWorkspace(e2eWorkspace.id),
    ).resolves.toMatchObject({
      workspaceId: e2eWorkspace.id,
      deleted: false,
      quarantined: true,
      purgeEligible: true,
      purgeAfter: '2026-09-02T00:00:00.000Z',
    });
    expect(workspaceService.deleteWorkspace).toHaveBeenCalledWith(
      e2eWorkspace.id,
      true,
    );
  });

  it('quarantines an unmarked workspace but makes it ineligible for purging', async () => {
    const { service, workspaceService, keyValuePairService } = makeService();

    workspaceService.findOneWorkspaceByIdIncludingDeleted.mockResolvedValue(
      e2eWorkspace,
    );
    keyValuePairService.get.mockResolvedValue([]);

    await expect(service.deleteWorkspace(e2eWorkspace.id)).resolves.toEqual({
      ok: true,
      id: e2eWorkspace.id,
      workspaceId: e2eWorkspace.id,
      deleted: true,
      quarantined: true,
      purgeEligible: false,
    });
    expect(workspaceService.deleteWorkspace).toHaveBeenCalledWith(
      e2eWorkspace.id,
      true,
    );
  });

  it('treats deletion of a missing workspace as already complete', async () => {
    const { service, workspaceService } = makeService();

    workspaceService.findOneWorkspaceByIdIncludingDeleted.mockResolvedValue(
      null,
    );

    await expect(service.deleteWorkspace(workspace.id)).resolves.toEqual({
      ok: true,
      id: workspace.id,
      workspaceId: workspace.id,
      deleted: false,
      quarantined: false,
      purgeEligible: false,
    });
    expect(workspaceService.deleteWorkspace).not.toHaveBeenCalled();
  });
});
