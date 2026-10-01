import {
  type SearchVectorTableConversionResult,
  SearchVectorTriggerConversionService,
} from 'src/engine/core-modules/search-vector-trigger/services/search-vector-trigger-conversion.service';

const buildService = () => {
  const workspaceCacheService = {
    getOrRecompute: jest.fn().mockResolvedValue({
      flatObjectMetadataMaps: { byUniversalIdentifier: {} },
      flatFieldMetadataMaps: { byUniversalIdentifier: {} },
      flatSearchFieldMetadataMaps: { byUniversalIdentifier: {} },
    }),
    invalidateAndRecompute: jest.fn(),
  };
  const service = new SearchVectorTriggerConversionService(
    {} as never,
    workspaceCacheService as never,
  );

  return { service, workspaceCacheService };
};

const plan = (tableName: string) => ({
  schemaName: 'workspace_abc',
  tableName,
  leanColumnExpression: 'lean',
  triggerRowExpression: 'trigger',
});

const result = (
  status: SearchVectorTableConversionResult['status'],
  mismatchCount = 0,
): SearchVectorTableConversionResult => ({ status, mismatchCount });

describe('SearchVectorTriggerConversionService.convertWorkspace', () => {
  afterEach(() => jest.clearAllMocks());

  const setup = (
    resolve: (args: {
      tableName: string;
      dryRun: boolean;
    }) => SearchVectorTableConversionResult,
  ) => {
    const { service } = buildService();

    jest
      .spyOn(service, 'buildWorkspaceTablePlans')
      .mockResolvedValue([plan('person'), plan('company'), plan('task')]);
    const convertTable = jest
      .spyOn(service, 'convertTable')
      .mockImplementation(async ({ tableName, dryRun }) =>
        resolve({ tableName, dryRun }),
      );

    return { service, convertTable };
  };

  const convertedTableNames = (convertTable: jest.SpyInstance) =>
    convertTable.mock.calls
      .filter(([args]) => !args.dryRun)
      .map(([args]) => args.tableName);

  it('converts nothing when any table mismatches', async () => {
    const { service, convertTable } = setup(({ tableName }) =>
      tableName === 'company' ? result('mismatch', 3) : result('dryRun'),
    );

    const report = await service.convertWorkspace({
      workspaceId: 'w1',
      dryRun: false,
    });

    expect(report.status).toBe('mismatch');
    expect(convertTable.mock.calls.every(([args]) => args.dryRun)).toBe(true);
  });

  it('converts every table when all checks pass', async () => {
    const { service } = setup(({ dryRun }) =>
      dryRun ? result('dryRun') : result('converted'),
    );

    const report = await service.convertWorkspace({
      workspaceId: 'w1',
      dryRun: false,
    });

    expect(report.status).toBe('converted');
  });

  it('treats already converted tables as done', async () => {
    const { service } = setup(({ tableName, dryRun }) => {
      if (dryRun) {
        return result('dryRun');
      }

      return tableName === 'person'
        ? result('alreadyConverted')
        : result('converted');
    });

    const report = await service.convertWorkspace({
      workspaceId: 'w1',
      dryRun: false,
    });

    expect(report.status).toBe('converted');
  });

  it('reports incomplete and stops when a table is busy', async () => {
    const { service, convertTable } = setup(({ tableName, dryRun }) => {
      if (dryRun) {
        return result('dryRun');
      }

      return tableName === 'company'
        ? result('lockTimeout')
        : result('converted');
    });

    const report = await service.convertWorkspace({
      workspaceId: 'w1',
      dryRun: false,
    });

    expect(report.status).toBe('incomplete');
    expect(report.tables).toEqual([
      { tableName: 'person', ...result('converted') },
      { tableName: 'company', ...result('lockTimeout') },
    ]);
    expect(convertedTableNames(convertTable)).toEqual(['person', 'company']);
  });

  it('reports mismatch and stops when a table changed between check and conversion', async () => {
    const { service, convertTable } = setup(({ tableName, dryRun }) => {
      if (dryRun) {
        return result('dryRun');
      }

      return tableName === 'company'
        ? result('mismatch', 2)
        : result('converted');
    });

    const report = await service.convertWorkspace({
      workspaceId: 'w1',
      dryRun: false,
    });

    expect(report.status).toBe('mismatch');
    expect(convertedTableNames(convertTable)).toEqual(['person', 'company']);
  });

  it('reports incomplete with the failing table when conversion throws', async () => {
    const { service, convertTable } = setup(({ tableName, dryRun }) => {
      if (dryRun) {
        return result('dryRun');
      }

      if (tableName === 'company') {
        throw new Error('boom');
      }

      return result('converted');
    });

    const report = await service.convertWorkspace({
      workspaceId: 'w1',
      dryRun: false,
    });

    expect(report.status).toBe('incomplete');
    expect(report.tables).toEqual([
      { tableName: 'person', ...result('converted') },
      {
        tableName: 'company',
        status: 'failed',
        mismatchCount: 0,
        error: 'boom',
      },
    ]);
    expect(convertedTableNames(convertTable)).toEqual(['person', 'company']);
  });

  it('dry run never converts', async () => {
    const { service, convertTable } = setup(() => result('dryRun'));

    const report = await service.convertWorkspace({
      workspaceId: 'w1',
      dryRun: true,
    });

    expect(report.status).toBe('dryRun');
    expect(convertTable.mock.calls.every(([args]) => args.dryRun)).toBe(true);
  });
});

describe('SearchVectorTriggerConversionService.buildWorkspaceTablePlans', () => {
  it('reads caches without invalidating them on a dry run', async () => {
    const { service, workspaceCacheService } = buildService();

    await service.convertWorkspace({ workspaceId: 'w1', dryRun: true });

    expect(workspaceCacheService.invalidateAndRecompute).not.toHaveBeenCalled();
    expect(workspaceCacheService.getOrRecompute).toHaveBeenCalledTimes(1);
  });

  it('refreshes caches before a real conversion', async () => {
    const { service, workspaceCacheService } = buildService();

    await service.convertWorkspace({ workspaceId: 'w1', dryRun: false });

    expect(workspaceCacheService.invalidateAndRecompute).toHaveBeenCalledWith(
      'w1',
      [
        'flatObjectMetadataMaps',
        'flatFieldMetadataMaps',
        'flatSearchFieldMetadataMaps',
      ],
    );
  });
});
