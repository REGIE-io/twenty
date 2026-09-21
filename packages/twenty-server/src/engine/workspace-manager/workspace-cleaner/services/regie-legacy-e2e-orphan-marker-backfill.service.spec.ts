import { type EntityManager, type Repository } from 'typeorm';

import { type KeyValuePairEntity } from 'src/engine/core-modules/key-value-pair/key-value-pair.entity';
import { type WorkspaceEntity } from 'src/engine/core-modules/workspace/workspace.entity';
import { RegieLegacyE2eOrphanMarkerBackfillService } from 'src/engine/workspace-manager/workspace-cleaner/services/regie-legacy-e2e-orphan-marker-backfill.service';

describe('RegieLegacyE2eOrphanMarkerBackfillService', () => {
  const workspace = {
    id: '20202020-0000-4000-8000-000000000001',
    subdomain: 'org-e2e-legacy-1',
    createdAt: new Date('2026-08-01T00:00:00.000Z'),
    deletedAt: new Date('2026-09-01T00:00:00.000Z'),
  };

  const makeService = (workspaces: unknown[] = [workspace]) => {
    const queryBuilder: Record<string, jest.Mock> = {};

    for (const method of ['withDeleted', 'where', 'andWhere', 'orderBy']) {
      queryBuilder[method] = jest.fn().mockReturnValue(queryBuilder);
    }
    queryBuilder.getMany = jest.fn().mockResolvedValue(workspaces);

    const workspaceRepository = {
      createQueryBuilder: jest.fn().mockReturnValue(queryBuilder),
    };
    const transactionRepository = { insert: jest.fn().mockResolvedValue({}) };
    let manager: EntityManager;

    manager = {
      getRepository: jest.fn().mockReturnValue(transactionRepository),
      transaction: jest.fn(
        async (callback: (entityManager: EntityManager) => Promise<unknown>) =>
          callback(manager),
      ),
    } as unknown as EntityManager;
    const markerRepository = { manager };
    const service = Reflect.construct(
      RegieLegacyE2eOrphanMarkerBackfillService,
      [
        workspaceRepository as unknown as Repository<WorkspaceEntity>,
        markerRepository as unknown as Repository<KeyValuePairEntity>,
      ],
    );

    return {
      service,
      queryBuilder,
      manager,
      transactionRepository,
    };
  };

  it('dry-runs a stable exact candidate set without writing markers', async () => {
    const { service, queryBuilder, manager } = makeService();

    const result = await service.run({
      apply: false,
      createdBefore: '2026-09-10T00:00:00.000Z',
    });

    expect(result).toMatchObject({
      applied: false,
      createdBefore: '2026-09-10T00:00:00.000Z',
      authorizedAt: null,
      count: 1,
      candidates: [
        {
          workspaceId: workspace.id,
          workspaceSlug: workspace.subdomain,
          createdAt: workspace.createdAt.toISOString(),
          quarantinedAt: workspace.deletedAt.toISOString(),
        },
      ],
    });
    expect(result.sha256).toMatch(/^[a-f0-9]{64}$/);
    expect(queryBuilder.andWhere).toHaveBeenCalledWith(
      'workspace.createdAt < :cutoff',
      { cutoff: new Date('2026-09-10T00:00:00.000Z') },
    );
    expect(manager.transaction).not.toHaveBeenCalled();
  });

  it('refuses apply when the reviewed candidate set does not match', async () => {
    const { service, manager } = makeService();

    await expect(
      service.run({
        apply: true,
        createdBefore: '2026-09-10T00:00:00.000Z',
        expectedCount: 2,
        expectedSha256: '0'.repeat(64),
      }),
    ).rejects.toThrow('Candidate set changed');
    expect(manager.transaction).not.toHaveBeenCalled();
  });

  it('writes a distinct exact-identity marker in one transaction', async () => {
    const { service, manager, transactionRepository } = makeService();
    const dryRun = await service.run({
      apply: false,
      createdBefore: '2026-09-10T00:00:00.000Z',
    });

    await expect(
      service.run({
        apply: true,
        createdBefore: '2026-09-10T00:00:00.000Z',
        expectedCount: dryRun.count,
        expectedSha256: dryRun.sha256,
      }),
    ).resolves.toMatchObject({ applied: true, count: 1 });

    expect(manager.transaction).toHaveBeenCalledTimes(1);
    expect(transactionRepository.insert).toHaveBeenCalledWith([
      expect.objectContaining({
        key: 'regie-internal:legacy-e2e-orphan-marker',
        workspaceId: workspace.id,
        value: expect.objectContaining({
          kind: 'LEGACY_ORPHAN',
          workspaceId: workspace.id,
          workspaceSlug: workspace.subdomain,
          source: 'reviewed-cross-database-backfill',
        }),
      }),
    ]);
  });
});
