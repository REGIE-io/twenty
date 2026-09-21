import { type Repository } from 'typeorm';

import { type KeyValuePairEntity } from 'src/engine/core-modules/key-value-pair/key-value-pair.entity';
import { type WorkspaceService } from 'src/engine/core-modules/workspace/services/workspace.service';
import { RegieE2eWorkspaceQuarantineBackfillWorkspaceService } from 'src/engine/workspace-manager/workspace-cleaner/services/regie-e2e-workspace-quarantine-backfill.workspace-service';

describe('RegieE2eWorkspaceQuarantineBackfillWorkspaceService', () => {
  const markerRow = ({
    organizationId = 'org_e2e_selected',
    workspaceId = '20202020-0000-4000-8000-000000000001',
    workspaceSlug = 'org-e2e-selected',
    deletedAt = null,
  }: {
    organizationId?: string;
    workspaceId?: string;
    workspaceSlug?: string;
    deletedAt?: Date | null;
  } = {}) => ({
    value: {
      ephemeral: true,
      organizationId,
      workspaceSlug,
    },
    workspace: {
      id: workspaceId,
      subdomain: workspaceSlug,
      deletedAt,
    },
  });

  const makeService = (rows: unknown[] = [markerRow()]) => {
    const queryBuilder: Record<string, jest.Mock> = {};

    for (const method of [
      'withDeleted',
      'innerJoinAndSelect',
      'where',
      'andWhere',
      'orderBy',
      'addOrderBy',
    ]) {
      queryBuilder[method] = jest.fn().mockReturnValue(queryBuilder);
    }
    queryBuilder.getMany = jest.fn().mockResolvedValue(rows);

    const repository = {
      createQueryBuilder: jest.fn().mockReturnValue(queryBuilder),
    };
    const workspaceService = {
      deleteWorkspace: jest.fn().mockResolvedValue(undefined),
    };
    const service = Reflect.construct(
      RegieE2eWorkspaceQuarantineBackfillWorkspaceService,
      [
        repository as unknown as Repository<KeyValuePairEntity>,
        workspaceService as unknown as WorkspaceService,
      ],
    );

    return { service, queryBuilder, workspaceService };
  };

  it('is a non-mutating dry run by default for an exact limited selection', async () => {
    const { service, queryBuilder, workspaceService } = makeService();

    await expect(
      service.run({
        mode: 'limited',
        apply: false,
        organizationIds: ['org_e2e_selected'],
      }),
    ).resolves.toMatchObject({
      mode: 'limited',
      applied: false,
      requestedOrganizationIds: ['org_e2e_selected'],
      unresolvedOrganizationIds: [],
      candidates: [
        {
          organizationId: 'org_e2e_selected',
          workspaceId: '20202020-0000-4000-8000-000000000001',
          workspaceSlug: 'org-e2e-selected',
        },
      ],
      quarantinedWorkspaceIds: [],
      counts: {
        requested: 1,
        unresolved: 0,
        candidates: 1,
        alreadyQuarantined: 0,
        quarantined: 0,
      },
    });
    expect(queryBuilder.andWhere).toHaveBeenCalledWith(
      "marker.value ->> 'organizationId' IN (:...organizationIds)",
      { organizationIds: ['org_e2e_selected'] },
    );
    expect(workspaceService.deleteWorkspace).not.toHaveBeenCalled();
  });

  it('applies only the exact safe limited selection', async () => {
    const selected = markerRow();
    const alreadyQuarantined = markerRow({
      organizationId: 'org_e2e_already',
      workspaceId: '20202020-0000-4000-8000-000000000002',
      workspaceSlug: 'org-e2e-already',
      deletedAt: new Date('2026-09-13T00:00:00.000Z'),
    });
    const { service, workspaceService } = makeService([
      selected,
      alreadyQuarantined,
    ]);

    const result = await service.run({
      mode: 'limited',
      apply: true,
      organizationIds: ['org_e2e_selected', 'org_e2e_already'],
    });

    expect(workspaceService.deleteWorkspace).toHaveBeenCalledTimes(1);
    expect(workspaceService.deleteWorkspace).toHaveBeenCalledWith(
      selected.workspace.id,
      true,
    );
    expect(result.quarantinedWorkspaceIds).toEqual([selected.workspace.id]);
    expect(result.alreadyQuarantined).toEqual([
      expect.objectContaining({ organizationId: 'org_e2e_already' }),
    ]);
    expect(result.counts).toEqual({
      requested: 2,
      unresolved: 0,
      candidates: 1,
      alreadyQuarantined: 1,
      quarantined: 1,
    });
  });

  it('refuses a partial apply when any requested account lacks one safe match', async () => {
    const { service, workspaceService } = makeService();

    await expect(
      service.run({
        mode: 'limited',
        apply: true,
        organizationIds: ['org_e2e_selected', 'org_e2e_not_found'],
      }),
    ).rejects.toThrow(
      'Refusing partial apply: no single safe workspace matched organization IDs: org_e2e_not_found',
    );
    expect(workspaceService.deleteWorkspace).not.toHaveBeenCalled();
  });

  it('treats a marker whose stored slug does not match the workspace as unresolved', async () => {
    const unsafe = markerRow();

    unsafe.workspace.subdomain = 'customer-production';
    const { service, workspaceService } = makeService([unsafe]);

    await expect(
      service.run({
        mode: 'limited',
        apply: true,
        organizationIds: ['org_e2e_selected'],
      }),
    ).rejects.toThrow(
      'Refusing partial apply: no single safe workspace matched organization IDs: org_e2e_selected',
    );
    expect(workspaceService.deleteWorkspace).not.toHaveBeenCalled();
  });

  it('all mode selects every safe marker but cannot be mixed with IDs', async () => {
    const { service, queryBuilder } = makeService();

    await expect(
      service.run({ mode: 'all', apply: false }),
    ).resolves.toMatchObject({
      mode: 'all',
      candidates: [
        expect.objectContaining({ organizationId: 'org_e2e_selected' }),
      ],
    });
    expect(queryBuilder.andWhere).not.toHaveBeenCalledWith(
      "marker.value ->> 'organizationId' IN (:...organizationIds)",
      expect.anything(),
    );
    await expect(
      service.run({
        mode: 'all',
        apply: false,
        organizationIds: ['org_e2e_selected'],
      }),
    ).rejects.toThrow('--all cannot be combined with --organization-ids');
  });

  it('requires E2E-prefixed IDs and rejects ambiguous marker matches', async () => {
    const { service } = makeService([markerRow(), markerRow()]);

    await expect(
      service.run({
        mode: 'limited',
        apply: false,
        organizationIds: ['customer-production'],
      }),
    ).rejects.toThrow('Every organization ID must start with org_e2e_');
    await expect(
      service.run({
        mode: 'limited',
        apply: false,
        organizationIds: ['org_e2e_selected'],
      }),
    ).rejects.toThrow(
      'Refusing ambiguous marker matches for organization IDs: org_e2e_selected',
    );
  });
});
