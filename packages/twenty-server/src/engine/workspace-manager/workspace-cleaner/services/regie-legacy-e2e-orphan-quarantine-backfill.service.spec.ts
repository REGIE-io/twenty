import { RegieLegacyE2eOrphanQuarantineBackfillWorkspaceService } from 'src/engine/workspace-manager/workspace-cleaner/services/regie-legacy-e2e-orphan-quarantine-backfill.workspace-service';

describe('RegieLegacyE2eOrphanQuarantineBackfillService', () => {
  const workspace = {
    id: '20202020-0000-4000-8000-000000000001',
    subdomain: 'org-e2e-legacy-active-1',
    createdAt: new Date('2026-08-01T00:00:00.000Z'),
  };

  const makeService = (workspaces: unknown[] = [workspace]) => {
    const queryBuilder: Record<string, jest.Mock> = {};

    for (const method of [
      'withDeleted',
      'where',
      'andWhere',
      'orderBy',
      'take',
    ]) {
      queryBuilder[method] = jest.fn().mockReturnValue(queryBuilder);
    }
    queryBuilder.getMany = jest.fn().mockResolvedValue(workspaces);

    const workspaceRepository = {
      createQueryBuilder: jest.fn().mockReturnValue(queryBuilder),
    };
    const markerRepository = {
      insert: jest.fn().mockResolvedValue({}),
    };
    const workspaceService = {
      deleteWorkspace: jest.fn().mockResolvedValue(workspace),
    };
    const service = Reflect.construct(
      RegieLegacyE2eOrphanQuarantineBackfillWorkspaceService,
      [workspaceRepository, markerRepository, workspaceService],
    );

    return {
      service,
      queryBuilder,
      markerRepository,
      workspaceService,
    };
  };

  it('dry-runs a stable bounded candidate set without mutation', async () => {
    const { service, queryBuilder, markerRepository, workspaceService } =
      makeService();

    const result = await service.run({
      apply: false,
      createdBefore: '2026-09-15T11:03:44.610Z',
      maxCandidates: 100,
    });

    expect(result).toMatchObject({
      applied: false,
      count: 1,
      quarantined: 0,
      marked: 0,
      candidates: [
        {
          workspaceId: workspace.id,
          workspaceSlug: workspace.subdomain,
        },
      ],
    });
    expect(result.sha256).toMatch(/^[a-f0-9]{64}$/);
    expect(queryBuilder.take).toHaveBeenCalledWith(100);
    expect(workspaceService.deleteWorkspace).not.toHaveBeenCalled();
    expect(markerRepository.insert).not.toHaveBeenCalled();
  });

  it('refuses apply when the reviewed batch fingerprint changes', async () => {
    const { service, markerRepository, workspaceService } = makeService();

    await expect(
      service.run({
        apply: true,
        createdBefore: '2026-09-15T11:03:44.610Z',
        maxCandidates: 100,
        expectedCount: 1,
        expectedSha256: '0'.repeat(64),
      }),
    ).rejects.toThrow('Candidate set changed');
    expect(workspaceService.deleteWorkspace).not.toHaveBeenCalled();
    expect(markerRepository.insert).not.toHaveBeenCalled();
  });

  it('soft-deletes through WorkspaceService before writing a fresh marker', async () => {
    const { service, markerRepository, workspaceService } = makeService();
    const dryRun = await service.run({
      apply: false,
      createdBefore: '2026-09-15T11:03:44.610Z',
      maxCandidates: 100,
    });

    await expect(
      service.run({
        apply: true,
        createdBefore: '2026-09-15T11:03:44.610Z',
        maxCandidates: 100,
        expectedCount: dryRun.count,
        expectedSha256: dryRun.sha256,
      }),
    ).resolves.toMatchObject({ quarantined: 1, marked: 1 });

    expect(workspaceService.deleteWorkspace).toHaveBeenCalledWith(
      workspace.id,
      true,
    );
    expect(markerRepository.insert).toHaveBeenCalledWith(
      expect.objectContaining({
        key: 'regie-internal:legacy-e2e-orphan-marker',
        workspaceId: workspace.id,
        value: expect.objectContaining({
          workspaceId: workspace.id,
          workspaceSlug: workspace.subdomain,
          kind: 'LEGACY_ORPHAN',
          source: 'reviewed-cross-database-backfill',
        }),
      }),
    );
    expect(
      workspaceService.deleteWorkspace.mock.invocationCallOrder[0],
    ).toBeLessThan(markerRepository.insert.mock.invocationCallOrder[0]);
  });

  it('rejects an unbounded or invalid batch size', async () => {
    const { service } = makeService();

    await expect(
      service.run({
        apply: false,
        createdBefore: '2026-09-15T11:03:44.610Z',
        maxCandidates: 0,
      }),
    ).rejects.toThrow('--max-candidates must be an integer between 1 and 100');
  });
});
