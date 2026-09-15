import { type Repository } from 'typeorm';

import { KeyValuePairEntity } from 'src/engine/core-modules/key-value-pair/key-value-pair.entity';
import { type WorkspaceService } from 'src/engine/core-modules/workspace/services/workspace.service';
import { RegieE2eWorkspaceSweeperService } from 'src/engine/workspace-manager/workspace-cleaner/services/regie-e2e-workspace-sweeper.service';

describe('RegieE2eWorkspaceSweeperService', () => {
  const workspace = {
    id: '20202020-0000-4000-8000-000000000001',
    subdomain: 'org-e2e-run-1',
    deletedAt: new Date('2026-09-01T00:00:00.000Z'),
  };
  const validMarkerRow = {
    workspace,
    value: {
      ephemeral: true,
      organizationId: 'org_e2e_run_1',
      workspaceSlug: workspace.subdomain,
    },
  };

  const makeService = (
    rows: unknown[],
    deleteWorkspace: jest.Mock = jest.fn().mockResolvedValue(workspace),
  ) => {
    const queryBuilder: Record<string, jest.Mock> = {};

    for (const method of [
      'innerJoinAndSelect',
      'withDeleted',
      'where',
      'andWhere',
      'orderBy',
      'limit',
    ]) {
      queryBuilder[method] = jest.fn().mockReturnValue(queryBuilder);
    }
    queryBuilder.getMany = jest.fn().mockResolvedValue(rows);

    const keyValuePairRepository = {
      createQueryBuilder: jest.fn().mockReturnValue(queryBuilder),
    };
    const workspaceService = { deleteWorkspace };
    const service = new RegieE2eWorkspaceSweeperService(
      workspaceService as unknown as WorkspaceService,
      keyValuePairRepository as unknown as Repository<KeyValuePairEntity>,
    );

    return { service, queryBuilder, workspaceService };
  };

  it('hard deletes a quarantined workspace with both persisted E2E identifiers', async () => {
    const { service, queryBuilder, workspaceService } = makeService([
      validMarkerRow,
    ]);

    await expect(
      service.purgeQuarantinedWorkspaces(new Date('2026-09-02T00:00:00.001Z')),
    ).resolves.toBe(1);

    expect(queryBuilder.limit).toHaveBeenCalledWith(15);
    expect(queryBuilder.withDeleted.mock.invocationCallOrder[0]).toBeLessThan(
      queryBuilder.innerJoinAndSelect.mock.invocationCallOrder[0],
    );
    expect(queryBuilder.andWhere).toHaveBeenCalledWith(
      'workspace.deletedAt <= :cutoff',
      { cutoff: new Date('2026-09-01T00:00:00.001Z') },
    );
    expect(workspaceService.deleteWorkspace).toHaveBeenCalledWith(workspace.id);
  });

  it('refuses a marker whose organization id is not E2E-scoped', async () => {
    const { service, workspaceService } = makeService([
      {
        ...validMarkerRow,
        value: {
          ...validMarkerRow.value,
          organizationId: 'org_customer',
        },
      },
    ]);

    await expect(service.purgeQuarantinedWorkspaces()).resolves.toBe(0);
    expect(workspaceService.deleteWorkspace).not.toHaveBeenCalled();
  });

  it('refuses a marker whose persisted slug does not match the workspace', async () => {
    const { service, workspaceService } = makeService([
      {
        ...validMarkerRow,
        value: {
          ...validMarkerRow.value,
          workspaceSlug: 'org-e2e-someone-else',
        },
      },
    ]);

    await expect(service.purgeQuarantinedWorkspaces()).resolves.toBe(0);
    expect(workspaceService.deleteWorkspace).not.toHaveBeenCalled();
  });

  it('refuses a real workspace even when its marker claims to be ephemeral', async () => {
    const realWorkspace = {
      ...workspace,
      subdomain: 'customer-production',
    };
    const { service, workspaceService } = makeService([
      {
        workspace: realWorkspace,
        value: {
          ephemeral: true,
          organizationId: 'org_e2e_forged',
          workspaceSlug: realWorkspace.subdomain,
        },
      },
    ]);

    await expect(service.purgeQuarantinedWorkspaces()).resolves.toBe(0);
    expect(workspaceService.deleteWorkspace).not.toHaveBeenCalled();
  });

  it('continues reaping independent workspaces after one deletion fails', async () => {
    const secondWorkspace = {
      ...workspace,
      id: '20202020-0000-4000-8000-000000000002',
      subdomain: 'org-e2e-run-2',
    };
    const deleteWorkspace = jest
      .fn()
      .mockRejectedValueOnce(new Error('injected metadata timeout'))
      .mockResolvedValueOnce(secondWorkspace);
    const { service } = makeService(
      [
        validMarkerRow,
        {
          workspace: secondWorkspace,
          value: {
            ephemeral: true,
            organizationId: 'org_e2e_run_2',
            workspaceSlug: secondWorkspace.subdomain,
          },
        },
      ],
      deleteWorkspace,
    );

    await expect(service.purgeQuarantinedWorkspaces()).resolves.toBe(1);
    expect(deleteWorkspace).toHaveBeenNthCalledWith(1, workspace.id);
    expect(deleteWorkspace).toHaveBeenNthCalledWith(2, secondWorkspace.id);
  });

  it('retries an eligible workspace on a later reaper pass', async () => {
    const deleteWorkspace = jest
      .fn()
      .mockRejectedValueOnce(new Error('injected schema timeout'))
      .mockResolvedValueOnce(workspace);
    const { service } = makeService([validMarkerRow], deleteWorkspace);

    await expect(service.purgeQuarantinedWorkspaces()).resolves.toBe(0);
    await expect(service.purgeQuarantinedWorkspaces()).resolves.toBe(1);
    expect(deleteWorkspace).toHaveBeenCalledTimes(2);
    expect(deleteWorkspace).toHaveBeenNthCalledWith(1, workspace.id);
    expect(deleteWorkspace).toHaveBeenNthCalledWith(2, workspace.id);
  });
});
