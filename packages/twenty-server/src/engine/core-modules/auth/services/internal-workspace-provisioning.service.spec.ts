import { BadRequestException, NotFoundException } from '@nestjs/common';

import { InternalWorkspaceProvisioningService } from 'src/engine/core-modules/auth/services/internal-workspace-provisioning.service';

jest.mock('src/engine/core-modules/api-key/services/api-key.service', () => ({
  ApiKeyService: class {},
}));
jest.mock('src/engine/core-modules/auth/services/sign-in-up.service', () => ({
  SignInUpService: class {},
}));
jest.mock('src/engine/core-modules/user/services/user.service', () => ({
  UserService: class {},
}));
jest.mock(
  'src/engine/core-modules/workspace/services/workspace.service',
  () => ({ WorkspaceService: class {} }),
);
jest.mock(
  'src/engine/core-modules/key-value-pair/key-value-pair.service',
  () => ({ KeyValuePairService: class {} }),
);

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
  const ciOwner = {
    repository: 'REGIE-io/go',
    runId: '123',
    runAttempt: 1,
    job: 'crm-api-records',
  };
  const ciMarker = {
    ephemeral: true,
    organizationId: 'org_e2e_run_1',
    workspaceSlug: e2eWorkspace.subdomain,
    owner: 'go-crm-ci',
    ciOwner,
    issuedAt: '2026-09-22T12:00:00.000Z',
    expiresAt: '2026-09-22T13:00:00.000Z',
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

  it('issues a one-hour CI lease before activation and never takes an expiry from the caller', async () => {
    const { service, signInUpService, workspaceService, keyValuePairService } =
      makeService();
    signInUpService.signUpOnNewWorkspace.mockResolvedValue({
      user,
      workspace: e2eWorkspace,
    });
    workspaceService.activateWorkspace.mockResolvedValue(e2eWorkspace);
    keyValuePairService.get.mockResolvedValue([]);
    const before = Date.now();

    await service.createWorkspace({
      name: 'CI run',
      slug: e2eWorkspace.subdomain,
      ephemeral: true,
      organizationId: 'org_e2e_run_1',
      ciOwner,
    });

    const marker = keyValuePairService.set.mock.calls[0][0].value;
    expect(marker).toMatchObject({
      ephemeral: true,
      organizationId: 'org_e2e_run_1',
      workspaceSlug: e2eWorkspace.subdomain,
      owner: 'go-crm-ci',
      ciOwner,
    });
    expect(Date.parse(marker.issuedAt)).toBeGreaterThanOrEqual(before);
    expect(Date.parse(marker.expiresAt) - Date.parse(marker.issuedAt)).toBe(
      3_600_000,
    );
    expect(keyValuePairService.set.mock.invocationCallOrder[0]).toBeLessThan(
      workspaceService.activateWorkspace.mock.invocationCallOrder[0],
    );
  });

  it('refuses a CI owner on a permanent workspace before creating anything', async () => {
    const { service, signInUpService } = makeService();

    await expect(
      service.createWorkspace({ name: 'Customer', slug: 'customer', ciOwner }),
    ).rejects.toThrow(BadRequestException);
    expect(signInUpService.signUpOnNewWorkspace).not.toHaveBeenCalled();
  });

  it('refuses to rebind a provisioned workspace from a different CI run', async () => {
    const { service, signInUpService, workspaceService, keyValuePairService } =
      makeService();
    signInUpService.signUpOnNewWorkspace.mockResolvedValue({
      user,
      workspace: e2eWorkspace,
    });
    keyValuePairService.get.mockResolvedValue([{ value: ciMarker }]);

    await expect(
      service.createWorkspace({
        name: 'CI run',
        slug: e2eWorkspace.subdomain,
        ephemeral: true,
        organizationId: 'org_e2e_run_1',
        ciOwner: { ...ciOwner, runId: 'another' },
      }),
    ).rejects.toThrow(BadRequestException);
    expect(keyValuePairService.set).not.toHaveBeenCalled();
    expect(workspaceService.activateWorkspace).not.toHaveBeenCalled();
  });

  it('requires the recorded owner for CI quarantine, including retries', async () => {
    const { service, workspaceService, keyValuePairService } = makeService();
    workspaceService.findOneWorkspaceByIdIncludingDeleted.mockResolvedValue(
      e2eWorkspace,
    );
    keyValuePairService.get.mockResolvedValue([{ value: ciMarker }]);

    for (const owner of [
      undefined,
      { ...ciOwner, repository: 'other/go' },
      { ...ciOwner, runAttempt: 2 },
      { ...ciOwner, job: 'different' },
    ]) {
      await expect(
        service.deleteWorkspace(e2eWorkspace.id, owner),
      ).rejects.toThrow(BadRequestException);
    }
    expect(workspaceService.deleteWorkspace).not.toHaveBeenCalled();
    await expect(
      service.deleteWorkspace(e2eWorkspace.id, ciOwner),
    ).resolves.toMatchObject({ quarantined: true, purgeEligible: true });
    expect(workspaceService.deleteWorkspace).toHaveBeenCalledWith(
      e2eWorkspace.id,
      true,
    );
  });

  it('refuses legacy marker backfill from stripping or granting CI ownership', async () => {
    const { service, workspaceService, keyValuePairService } = makeService();
    workspaceService.findOneWorkspaceByIdIncludingDeleted.mockResolvedValue(
      e2eWorkspace,
    );
    keyValuePairService.get.mockResolvedValue([{ value: ciMarker }]);
    const identity = {
      organizationId: 'org_e2e_run_1',
      workspaceSlug: e2eWorkspace.subdomain,
    };

    await expect(
      service.backfillE2eWorkspaceMarker(e2eWorkspace.id, identity),
    ).rejects.toThrow(BadRequestException);
    await expect(
      service.backfillE2eWorkspaceMarker(e2eWorkspace.id, {
        ...identity,
        ciOwner,
      }),
    ).resolves.toMatchObject({ backfilled: false });
    keyValuePairService.get.mockResolvedValue([]);
    await expect(
      service.backfillE2eWorkspaceMarker(e2eWorkspace.id, {
        ...identity,
        ciOwner,
      }),
    ).rejects.toThrow(BadRequestException);
    expect(keyValuePairService.set).not.toHaveBeenCalled();
  });

  it('refuses to reactivate an expired CI lease', async () => {
    const { service, workspaceService, keyValuePairService } = makeService();
    workspaceService.findOneWorkspaceById.mockResolvedValue(e2eWorkspace);
    keyValuePairService.get.mockResolvedValue([
      {
        value: {
          ...ciMarker,
          issuedAt: '2000-01-01T00:00:00.000Z',
          expiresAt: '2000-01-01T01:00:00.000Z',
        },
      },
    ]);

    await expect(
      service.activateWorkspace(e2eWorkspace.id, ciOwner),
    ).rejects.toThrow(BadRequestException);
    expect(workspaceService.activateWorkspace).not.toHaveBeenCalled();
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
    const quarantinedAt = new Date('2026-09-01T00:00:00.000Z');

    workspaceService.findOneWorkspaceByIdIncludingDeleted
      .mockResolvedValueOnce(e2eWorkspace)
      .mockResolvedValueOnce({ ...e2eWorkspace, deletedAt: quarantinedAt });

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
    expect(result.purgeAfter).toBe('2026-09-02T00:00:00.000Z');
  });

  it('backfills a marker from an exact legacy E2E workspace mapping', async () => {
    const { service, workspaceService, keyValuePairService } = makeService();

    workspaceService.findOneWorkspaceByIdIncludingDeleted.mockResolvedValue(
      e2eWorkspace,
    );
    keyValuePairService.get.mockResolvedValue([]);

    await expect(
      service.backfillE2eWorkspaceMarker(e2eWorkspace.id, {
        organizationId: 'org_e2e_run_1',
        workspaceSlug: e2eWorkspace.subdomain,
      }),
    ).resolves.toEqual({
      ok: true,
      workspaceId: e2eWorkspace.id,
      organizationId: 'org_e2e_run_1',
      workspaceSlug: e2eWorkspace.subdomain,
      backfilled: true,
      purgeEligible: true,
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
  });

  it('refuses a legacy marker that does not exactly match the workspace', async () => {
    const { service, workspaceService, keyValuePairService } = makeService();

    workspaceService.findOneWorkspaceByIdIncludingDeleted.mockResolvedValue(
      e2eWorkspace,
    );
    keyValuePairService.get.mockResolvedValue([]);

    await expect(
      service.backfillE2eWorkspaceMarker(e2eWorkspace.id, {
        organizationId: 'org_e2e_run_1',
        workspaceSlug: 'org-e2e-different-run',
      }),
    ).rejects.toThrow(BadRequestException);
    expect(keyValuePairService.set).not.toHaveBeenCalled();
  });

  it('does not overwrite a conflicting legacy E2E marker', async () => {
    const { service, workspaceService, keyValuePairService } = makeService();

    workspaceService.findOneWorkspaceByIdIncludingDeleted.mockResolvedValue(
      e2eWorkspace,
    );
    keyValuePairService.get.mockResolvedValue([
      {
        value: {
          ephemeral: true,
          organizationId: 'org_e2e_other_run',
          workspaceSlug: e2eWorkspace.subdomain,
        },
      },
    ]);

    await expect(
      service.backfillE2eWorkspaceMarker(e2eWorkspace.id, {
        organizationId: 'org_e2e_run_1',
        workspaceSlug: e2eWorkspace.subdomain,
      }),
    ).rejects.toThrow(BadRequestException);
    expect(keyValuePairService.set).not.toHaveBeenCalled();
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
    expect(workspaceService.deleteWorkspace).not.toHaveBeenCalled();
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
