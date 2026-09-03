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

  const makeService = (rows: unknown[]) => {
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
    const workspaceService = {
      deleteWorkspace: jest.fn().mockResolvedValue(workspace),
    };
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

    expect(queryBuilder.limit).toHaveBeenCalledWith(10);
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
});
