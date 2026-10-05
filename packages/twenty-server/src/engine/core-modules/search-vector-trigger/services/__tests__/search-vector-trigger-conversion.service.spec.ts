import { FeatureFlagKey } from 'twenty-shared/types';

import {
  type SearchVectorTableConversionResult,
  SearchVectorTriggerConversionService,
} from 'src/engine/core-modules/search-vector-trigger/services/search-vector-trigger-conversion.service';
import { upsertSearchVectorBackfillJob } from 'src/engine/core-modules/search-vector-trigger/utils/search-vector-backfill.util';
import {
  countSearchVectorMismatches,
  getExistingSearchVectorColumnState,
  getSearchVectorColumnState,
  hasSearchVectorTrigger,
  selectMismatchCount,
} from 'src/engine/core-modules/search-vector-trigger/utils/search-vector-table-queries.util';
import {
  convertGeneratedSearchVectorColumn,
  installSearchVectorTrigger,
  type SearchVectorUnplannedTable,
} from 'src/engine/core-modules/search-vector-trigger/utils/search-vector-trigger-maintenance.util';
import { deriveCheckedSearchVectorExpression } from 'src/engine/metadata-modules/flat-search-field-metadata/utils/derive-checked-search-vector-expression.util';
import { findTsVectorFlatFieldMetadataForObject } from 'src/engine/metadata-modules/flat-search-field-metadata/utils/find-ts-vector-flat-field-metadata-for-object.util';
import { getTargetSearchFieldMetadatasForTsVectorField } from 'src/engine/metadata-modules/flat-search-field-metadata/utils/get-target-search-field-metadatas-for-ts-vector-field.util';
import {
  WorkspaceMigrationActionExecutionException,
  WorkspaceMigrationActionExecutionExceptionCode,
} from 'src/engine/workspace-manager/workspace-migration/workspace-migration-runner/exceptions/workspace-migration-action-execution.exception';

jest.mock(
  'src/engine/core-modules/search-vector-trigger/utils/search-vector-backfill.util',
  () => ({ upsertSearchVectorBackfillJob: jest.fn() }),
);
jest.mock(
  'src/engine/core-modules/search-vector-trigger/utils/search-vector-table-queries.util',
  () => ({
    ...jest.requireActual(
      'src/engine/core-modules/search-vector-trigger/utils/search-vector-table-queries.util',
    ),
    countSearchVectorMismatches: jest.fn().mockResolvedValue(0),
    getExistingSearchVectorColumnState: jest.fn(),
    getSearchVectorColumnState: jest.fn(),
    hasSearchVectorTrigger: jest.fn(),
    selectMismatchCount: jest.fn(),
  }),
);
jest.mock(
  'src/engine/core-modules/search-vector-trigger/utils/search-vector-trigger-maintenance.util',
  () => ({
    ...jest.requireActual(
      'src/engine/core-modules/search-vector-trigger/utils/search-vector-trigger-maintenance.util',
    ),
    convertGeneratedSearchVectorColumn: jest.fn(),
    installSearchVectorTrigger: jest.fn(),
  }),
);
jest.mock(
  'src/engine/metadata-modules/flat-search-field-metadata/utils/derive-checked-search-vector-expression.util',
  () => ({ deriveCheckedSearchVectorExpression: jest.fn() }),
);
jest.mock(
  'src/engine/metadata-modules/flat-search-field-metadata/utils/find-ts-vector-flat-field-metadata-for-object.util',
  () => ({ findTsVectorFlatFieldMetadataForObject: jest.fn() }),
);
jest.mock(
  'src/engine/metadata-modules/flat-search-field-metadata/utils/get-target-search-field-metadatas-for-ts-vector-field.util',
  () => ({ getTargetSearchFieldMetadatasForTsVectorField: jest.fn() }),
);

const EXPRESSION = `to_tsvector('simple', COALESCE("jobTitle", ''))`;

const buildService = ({
  isLockAvailable = true,
  events = [],
}: { isLockAvailable?: boolean; events?: string[] } = {}) => {
  const queryRunner = {
    connect: jest.fn(),
    startTransaction: jest.fn(),
    commitTransaction: jest.fn(),
    rollbackTransaction: jest.fn(),
    release: jest.fn(),
    query: jest.fn().mockResolvedValue([]),
    isTransactionActive: false,
  };
  const dataSource = {
    createQueryRunner: () => queryRunner,
    transaction: jest.fn(
      async (callback: (entityManager: unknown) => Promise<unknown>) =>
        callback({ queryRunner }),
    ),
  };
  const workspaceCacheService = {
    getOrRecompute: jest.fn().mockResolvedValue({
      flatObjectMetadataMaps: { byUniversalIdentifier: {} },
      flatFieldMetadataMaps: { byUniversalIdentifier: {}, byId: {} },
      flatSearchFieldMetadataMaps: { byUniversalIdentifier: {} },
    }),
    invalidateAndRecompute: jest.fn(),
  };
  const featureFlagService = { upsertWorkspaceFeatureFlag: jest.fn() };
  const postgresAdvisoryLockService = {
    tryWithLock: jest.fn(
      async (_lockName: string, callback: () => Promise<unknown>) => {
        if (!isLockAvailable) {
          return { acquired: false };
        }

        events.push('lock acquired');
        const value = await callback();

        events.push('lock released');

        return { acquired: true, value };
      },
    ),
  };
  const service = new SearchVectorTriggerConversionService(
    dataSource as never,
    workspaceCacheService as never,
    featureFlagService as never,
    postgresAdvisoryLockService as never,
  );

  return {
    service,
    queryRunner,
    workspaceCacheService,
    featureFlagService,
    postgresAdvisoryLockService,
  };
};

const plan = (tableName: string) => ({
  objectMetadataId: `${tableName}-object-id`,
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
  afterEach(() => {
    jest.clearAllMocks();
    jest.useRealTimers();
  });

  const setup = ({
    check = () => result('dryRun'),
    switchTo = () => result('converted'),
    unplannedTables = [],
    isLockAvailable,
    lockedPlans = [plan('person'), plan('company'), plan('task')],
  }: {
    check?: (tableName: string) => SearchVectorTableConversionResult;
    switchTo?: (tableName: string) => SearchVectorTableConversionResult;
    unplannedTables?: SearchVectorUnplannedTable[];
    isLockAvailable?: boolean;
    lockedPlans?: ReturnType<typeof plan>[];
  } = {}) => {
    const events: string[] = [];
    const built = buildService({ isLockAvailable, events });
    let buildCount = 0;

    const buildWorkspaceTablePlans = jest
      .spyOn(built.service, 'buildWorkspaceTablePlans')
      .mockImplementation(async () => {
        events.push('plans built');
        buildCount += 1;

        return {
          plans:
            buildCount === 1
              ? [plan('person'), plan('company'), plan('task')]
              : lockedPlans,
          unplannedTables,
        };
      });
    const checkTable = jest
      .spyOn(built.service, 'checkTable')
      .mockImplementation(async ({ tableName }) => {
        events.push(`check ${tableName}`);

        return check(tableName);
      });
    const switchTable = jest
      .spyOn(built.service, 'switchTable')
      .mockImplementation(async ({ tableName }) => {
        events.push(`switch ${tableName}`);

        return switchTo(tableName);
      });

    jest
      .mocked(countSearchVectorMismatches)
      .mockImplementation(async (_queryRunner, qualifiedTable) => {
        events.push(`verify ${qualifiedTable}`);

        return 0;
      });

    return {
      ...built,
      buildWorkspaceTablePlans,
      checkTable,
      switchTable,
      events,
    };
  };

  const switchedTableNames = (switchTable: jest.SpyInstance) =>
    switchTable.mock.calls.map(([args]) => args.tableName);

  it('converts nothing and takes no lock when any table mismatches', async () => {
    const {
      service,
      switchTable,
      featureFlagService,
      postgresAdvisoryLockService,
    } = setup({
      check: (tableName) =>
        tableName === 'company' ? result('mismatch', 3) : result('dryRun'),
    });

    const report = await service.convertWorkspace({
      workspaceId: 'w1',
      dryRun: false,
    });

    expect(report.status).toBe('mismatch');
    expect(switchTable).not.toHaveBeenCalled();
    expect(postgresAdvisoryLockService.tryWithLock).not.toHaveBeenCalled();
    expect(
      featureFlagService.upsertWorkspaceFeatureFlag,
    ).not.toHaveBeenCalled();
  });

  it('converts every table and sets the flag when all checks pass', async () => {
    const { service, featureFlagService } = setup();

    const report = await service.convertWorkspace({
      workspaceId: 'w1',
      dryRun: false,
    });

    expect(report.status).toBe('converted');
    expect(featureFlagService.upsertWorkspaceFeatureFlag).toHaveBeenCalledWith({
      workspaceId: 'w1',
      featureFlag: FeatureFlagKey.IS_SEARCH_VECTOR_TRIGGER_ENABLED,
      value: true,
    });
  });

  it('sets the flag when tables are already converted, repaired or skipped', async () => {
    const { service, featureFlagService } = setup({
      check: (tableName) =>
        tableName === 'task' ? result('needsRepair', 4) : result('dryRun'),
      switchTo: (tableName) => {
        if (tableName === 'person') {
          return result('alreadyConverted');
        }

        return tableName === 'task'
          ? result('repaired', 4)
          : result('converted');
      },
      unplannedTables: [
        { tableName: 'note', status: 'skipped', mismatchCount: 0 },
      ],
    });

    const report = await service.convertWorkspace({
      workspaceId: 'w1',
      dryRun: false,
      repair: true,
    });

    expect(report.status).toBe('converted');
    expect(report.tables.map((table) => table.status)).toEqual([
      'skipped',
      'alreadyConverted',
      'converted',
      'repaired',
    ]);
    expect(featureFlagService.upsertWorkspaceFeatureFlag).toHaveBeenCalledTimes(
      1,
    );
  });

  it('passes the check mismatch count, and the repair target only with --repair', async () => {
    const { service, checkTable, switchTable } = setup({
      check: (tableName) =>
        tableName === 'company' ? result('needsRepair', 2) : result('dryRun'),
    });

    await service.convertWorkspace({
      workspaceId: 'w1',
      dryRun: false,
      repair: true,
    });

    expect(switchTable).toHaveBeenCalledWith(
      expect.objectContaining({
        tableName: 'company',
        mismatchCount: 2,
        repair: { workspaceId: 'w1', objectMetadataId: 'company-object-id' },
      }),
    );

    checkTable.mockClear();
    switchTable.mockClear();
    await service.convertWorkspace({ workspaceId: 'w1', dryRun: false });

    expect(
      [...checkTable.mock.calls, ...switchTable.mock.calls].every(
        ([args]) => args.repair === undefined,
      ),
    ).toBe(true);
  });

  it('blocks the workspace, converts nothing and leaves the flag off when a table is blocked', async () => {
    const { service, switchTable, featureFlagService } = setup({
      unplannedTables: [
        {
          tableName: 'opportunity',
          status: 'blocked',
          mismatchCount: 0,
          error: 'standard search fields missing',
        },
      ],
    });

    const report = await service.convertWorkspace({
      workspaceId: 'w1',
      dryRun: false,
    });

    expect(report.status).toBe('blocked');
    expect(switchTable).not.toHaveBeenCalled();
    expect(
      featureFlagService.upsertWorkspaceFeatureFlag,
    ).not.toHaveBeenCalled();
  });

  it('dry run lists every table, blocked ones included', async () => {
    const { service } = setup({
      unplannedTables: [
        {
          tableName: 'opportunity',
          status: 'blocked',
          mismatchCount: 0,
          error: 'standard search fields missing',
        },
      ],
    });

    const report = await service.convertWorkspace({
      workspaceId: 'w1',
      dryRun: true,
    });

    expect(report.status).toBe('blocked');
    expect(report.tables.map((table) => table.tableName)).toEqual([
      'opportunity',
      'person',
      'company',
      'task',
    ]);
  });

  it('scans before the lock, holds it only for the switch, and verifies after', async () => {
    const { service, events } = setup({
      switchTo: (tableName) =>
        tableName === 'task' ? result('alreadyConverted') : result('converted'),
    });

    await service.convertWorkspace({ workspaceId: 'w1', dryRun: false });

    expect(events).toEqual([
      'plans built',
      'check person',
      'check company',
      'check task',
      'lock acquired',
      'plans built',
      'switch person',
      'switch company',
      'switch task',
      'lock released',
      'verify "workspace_abc"."person"',
      'verify "workspace_abc"."company"',
    ]);
  });

  it('takes no lock on a dry run', async () => {
    const { service, postgresAdvisoryLockService } = setup();

    await service.convertWorkspace({ workspaceId: 'w1', dryRun: true });

    expect(postgresAdvisoryLockService.tryWithLock).not.toHaveBeenCalled();
  });

  it('reports busy without converting when the lock stays taken', async () => {
    jest.useFakeTimers();
    const {
      service,
      switchTable,
      featureFlagService,
      postgresAdvisoryLockService,
    } = setup({ isLockAvailable: false });

    const reportPromise = service.convertWorkspace({
      workspaceId: 'w1',
      dryRun: false,
    });

    await jest.runAllTimersAsync();

    await expect(reportPromise).resolves.toEqual({
      status: 'busy',
      tables: [],
    });
    expect(
      postgresAdvisoryLockService.tryWithLock.mock.calls.length,
    ).toBeGreaterThan(1);
    expect(postgresAdvisoryLockService.tryWithLock).toHaveBeenCalledWith(
      'search-vector-conversion:w1',
      expect.any(Function),
    );
    expect(switchTable).not.toHaveBeenCalled();
    expect(
      featureFlagService.upsertWorkspaceFeatureFlag,
    ).not.toHaveBeenCalled();
  });

  it('reports incomplete and stops when a table is busy', async () => {
    const { service, switchTable, featureFlagService } = setup({
      switchTo: (tableName) =>
        tableName === 'company' ? result('lockTimeout') : result('converted'),
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
    expect(switchedTableNames(switchTable)).toEqual(['person', 'company']);
    expect(
      featureFlagService.upsertWorkspaceFeatureFlag,
    ).not.toHaveBeenCalled();
  });

  it.each([
    [
      'a search list changed',
      [
        plan('person'),
        { ...plan('company'), leanColumnExpression: 'new' },
        plan('task'),
      ],
    ],
    [
      'a trigger formula changed',
      [
        plan('person'),
        plan('company'),
        { ...plan('task'), triggerRowExpression: 'new' },
      ],
    ],
    [
      'a table appeared',
      [plan('person'), plan('company'), plan('task'), plan('note')],
    ],
    ['a table disappeared', [plan('person'), plan('company')]],
    ['a table was replaced', [plan('person'), plan('company'), plan('note')]],
  ])(
    'reports changed and converts nothing when %s between check and lock',
    async (_change, lockedPlans) => {
      const { service, switchTable, featureFlagService } = setup({
        lockedPlans,
      });

      const report = await service.convertWorkspace({
        workspaceId: 'w1',
        dryRun: false,
      });

      expect(report.status).toBe('changed');
      expect(switchTable).not.toHaveBeenCalled();
      expect(
        featureFlagService.upsertWorkspaceFeatureFlag,
      ).not.toHaveBeenCalled();
    },
  );

  it('reports incomplete with the failing table when a switch throws', async () => {
    const { service, switchTable } = setup({
      switchTo: (tableName) => {
        if (tableName === 'company') {
          throw new Error('boom');
        }

        return result('converted');
      },
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
    expect(switchedTableNames(switchTable)).toEqual(['person', 'company']);
  });

  it('queues a REPAIR backfill for rows written during the switch', async () => {
    const { service, queryRunner } = setup();

    jest
      .mocked(countSearchVectorMismatches)
      .mockImplementation(async (_queryRunner, qualifiedTable) =>
        qualifiedTable.includes('company') ? 2 : 0,
      );

    const report = await service.convertWorkspace({
      workspaceId: 'w1',
      dryRun: false,
    });

    expect(report.status).toBe('converted');
    expect(report.tables[1]).toEqual(
      expect.objectContaining({
        tableName: 'company',
        status: 'repaired',
        mismatchCount: 2,
      }),
    );
    expect(upsertSearchVectorBackfillJob).toHaveBeenCalledTimes(1);
    expect(upsertSearchVectorBackfillJob).toHaveBeenCalledWith(queryRunner, {
      workspaceId: 'w1',
      objectMetadataId: 'company-object-id',
      request: { reason: 'REPAIR', filter: null },
    });
  });

  it('reports incomplete when the verify scan fails', async () => {
    const { service } = setup();

    jest
      .mocked(countSearchVectorMismatches)
      .mockRejectedValueOnce(new Error('statement timeout'));

    const report = await service.convertWorkspace({
      workspaceId: 'w1',
      dryRun: false,
    });

    expect(report.status).toBe('incomplete');
    expect(report.tables[0]).toEqual(
      expect.objectContaining({
        tableName: 'person',
        status: 'failed',
        error: 'statement timeout',
      }),
    );
  });

  it('dry run never converts', async () => {
    const { service, switchTable, featureFlagService } = setup();

    const report = await service.convertWorkspace({
      workspaceId: 'w1',
      dryRun: true,
    });

    expect(report.status).toBe('dryRun');
    expect(switchTable).not.toHaveBeenCalled();
    expect(
      featureFlagService.upsertWorkspaceFeatureFlag,
    ).not.toHaveBeenCalled();
  });
});

describe('SearchVectorTriggerConversionService.buildWorkspaceTablePlans', () => {
  afterEach(() => jest.clearAllMocks());

  const objectWithSearchFields = (
    nameSingular: string,
    searchFieldCount: number,
  ) => ({
    id: `${nameSingular}-object-id`,
    nameSingular,
    isCustom: true,
    fieldIds: [],
    fieldUniversalIdentifiers: [`${nameSingular}-object-id`],
    searchFieldCount,
  });

  const buildServiceWithObjects = (
    objects: ReturnType<typeof objectWithSearchFields>[],
  ) => {
    const built = buildService();

    built.workspaceCacheService.getOrRecompute.mockResolvedValue({
      flatObjectMetadataMaps: {
        byUniversalIdentifier: Object.fromEntries(
          objects.map((object) => [object.id, object]),
        ),
      },
      flatFieldMetadataMaps: { byUniversalIdentifier: {}, byId: {} },
      flatSearchFieldMetadataMaps: { byUniversalIdentifier: {} },
    });

    // Each object's search vector field id is its own id, so the search list follows the object.
    jest
      .mocked(findTsVectorFlatFieldMetadataForObject)
      .mockImplementation(
        ({ fieldUniversalIdentifiers }) =>
          ({ id: fieldUniversalIdentifiers[0] }) as never,
      );
    jest
      .mocked(getTargetSearchFieldMetadatasForTsVectorField)
      .mockImplementation(
        ({ tsVectorFieldMetadataId }) =>
          Array.from(
            {
              length:
                objects.find((object) => object.id === tsVectorFieldMetadataId)
                  ?.searchFieldCount ?? 0,
            },
            () => ({}),
          ) as never,
      );
    jest
      .mocked(deriveCheckedSearchVectorExpression)
      .mockImplementation(({ flatObjectMetadata }) => {
        if (flatObjectMetadata.nameSingular === 'opportunity') {
          throw new WorkspaceMigrationActionExecutionException({
            message: 'standard search fields missing: name',
            code: WorkspaceMigrationActionExecutionExceptionCode.MISSING_STANDARD_SEARCH_FIELDS,
          });
        }

        if (flatObjectMetadata.nameSingular === 'broken') {
          throw new Error('unexpected');
        }

        return EXPRESSION;
      });

    return built;
  };

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

  it('skips objects with nothing to search and blocks objects failing the guard', async () => {
    const { service } = buildServiceWithObjects([
      objectWithSearchFields('person', 2),
      objectWithSearchFields('note', 0),
      objectWithSearchFields('opportunity', 1),
    ]);

    const { plans, unplannedTables } = await service.buildWorkspaceTablePlans(
      '20202020-0000-0000-0000-000000000001',
      { refreshCache: false },
    );

    expect(plans.map((tablePlan) => tablePlan.objectMetadataId)).toEqual([
      'person-object-id',
    ]);
    expect(unplannedTables).toEqual([
      expect.objectContaining({ status: 'skipped', mismatchCount: 0 }),
      expect.objectContaining({
        status: 'blocked',
        error: 'standard search fields missing: name',
      }),
    ]);
  });

  it('throws on any other error', async () => {
    const { service } = buildServiceWithObjects([
      objectWithSearchFields('broken', 1),
    ]);

    await expect(
      service.buildWorkspaceTablePlans('20202020-0000-0000-0000-000000000001', {
        refreshCache: false,
      }),
    ).rejects.toThrow('unexpected');
  });
});

describe('SearchVectorTriggerConversionService.convertTable', () => {
  afterEach(() => jest.clearAllMocks());

  const repair = { workspaceId: 'w1', objectMetadataId: 'person-object-id' };

  const convert = (
    service: SearchVectorTriggerConversionService,
    options: { dryRun: boolean; repair?: typeof repair },
  ) =>
    service.convertTable({
      schemaName: 'workspace_abc',
      tableName: 'person',
      leanColumnExpression: EXPRESSION,
      triggerRowExpression: EXPRESSION,
      ...options,
    });

  const givenTable = ({
    columnState,
    mismatchCount,
    lockedMismatchCount = 0,
    hasTrigger = false,
  }: {
    columnState: 'generated' | 'plain';
    mismatchCount: number;
    lockedMismatchCount?: number;
    hasTrigger?: boolean;
  }) => {
    jest
      .mocked(getExistingSearchVectorColumnState)
      .mockResolvedValue(columnState);
    jest.mocked(getSearchVectorColumnState).mockResolvedValue(columnState);
    jest.mocked(countSearchVectorMismatches).mockResolvedValue(mismatchCount);
    jest.mocked(selectMismatchCount).mockResolvedValue(lockedMismatchCount);
    jest.mocked(hasSearchVectorTrigger).mockResolvedValue(hasTrigger);
  };

  const ddlFor = (columnState: 'generated' | 'plain') =>
    columnState === 'generated'
      ? convertGeneratedSearchVectorColumn
      : installSearchVectorTrigger;

  it.each(['generated', 'plain'] as const)(
    'refuses a mismatched %s table without --repair',
    async (columnState) => {
      const { service } = buildService();

      givenTable({ columnState, mismatchCount: 3 });

      await expect(convert(service, { dryRun: false })).resolves.toEqual(
        result('mismatch', 3),
      );
      expect(ddlFor(columnState)).not.toHaveBeenCalled();
      expect(upsertSearchVectorBackfillJob).not.toHaveBeenCalled();
    },
  );

  it.each(['generated', 'plain'] as const)(
    'reports a mismatched %s table as needing repair on a dry run with --repair',
    async (columnState) => {
      const { service } = buildService();

      givenTable({ columnState, mismatchCount: 3 });

      await expect(convert(service, { dryRun: true, repair })).resolves.toEqual(
        result('needsRepair', 3),
      );
      expect(ddlFor(columnState)).not.toHaveBeenCalled();
      expect(upsertSearchVectorBackfillJob).not.toHaveBeenCalled();
    },
  );

  it.each(['generated', 'plain'] as const)(
    'repairs a mismatched %s table and queues a whole-table REPAIR backfill in the same transaction',
    async (columnState) => {
      const { service, queryRunner } = buildService();

      givenTable({ columnState, mismatchCount: 3 });

      await expect(
        convert(service, { dryRun: false, repair }),
      ).resolves.toEqual(result('repaired', 3));
      expect(ddlFor(columnState)).toHaveBeenCalledTimes(1);
      expect(upsertSearchVectorBackfillJob).toHaveBeenCalledWith(queryRunner, {
        workspaceId: 'w1',
        objectMetadataId: 'person-object-id',
        request: { reason: 'REPAIR', filter: null },
      });
      // The switch's commit is the last one; the first closes the read-only mismatch check.
      const jobCallOrder = jest.mocked(upsertSearchVectorBackfillJob).mock
        .invocationCallOrder[0];

      expect(jobCallOrder).toBeGreaterThan(
        jest.mocked(ddlFor(columnState)).mock.invocationCallOrder[0],
      );
      expect(jobCallOrder).toBeLessThan(
        Math.max(...queryRunner.commitTransaction.mock.invocationCallOrder),
      );
    },
  );

  it('converts a clean generated table without a backfill even with --repair', async () => {
    const { service } = buildService();

    givenTable({ columnState: 'generated', mismatchCount: 0 });

    await expect(convert(service, { dryRun: false, repair })).resolves.toEqual(
      result('converted'),
    );
    expect(convertGeneratedSearchVectorColumn).toHaveBeenCalledTimes(1);
    expect(upsertSearchVectorBackfillJob).not.toHaveBeenCalled();
  });

  it('rechecks a trigger-less plain table under a write lock and refuses a late mismatch', async () => {
    const { service, queryRunner } = buildService();

    givenTable({
      columnState: 'plain',
      mismatchCount: 0,
      lockedMismatchCount: 2,
    });

    await expect(convert(service, { dryRun: false })).resolves.toEqual(
      result('mismatch', 2),
    );
    expect(queryRunner.query).toHaveBeenCalledWith(
      expect.stringContaining('IN SHARE ROW EXCLUSIVE MODE'),
    );
    expect(queryRunner.rollbackTransaction).toHaveBeenCalled();
    expect(installSearchVectorTrigger).not.toHaveBeenCalled();
  });

  it('reinstalls the trigger of an already converted table without a lock or rescan', async () => {
    const { service, queryRunner } = buildService();

    givenTable({ columnState: 'plain', mismatchCount: 0, hasTrigger: true });

    await expect(convert(service, { dryRun: false })).resolves.toEqual(
      result('alreadyConverted'),
    );
    expect(installSearchVectorTrigger).toHaveBeenCalledTimes(1);
    expect(selectMismatchCount).not.toHaveBeenCalled();
    expect(queryRunner.query).not.toHaveBeenCalledWith(
      expect.stringContaining('LOCK TABLE'),
    );
  });

  it('reports lockTimeout when the switch cannot get its table lock', async () => {
    const { service } = buildService();

    givenTable({ columnState: 'generated', mismatchCount: 0 });
    jest
      .mocked(convertGeneratedSearchVectorColumn)
      .mockRejectedValueOnce(
        Object.assign(new Error('lock'), { code: '55P03' }),
      );

    await expect(convert(service, { dryRun: false })).resolves.toEqual(
      result('lockTimeout'),
    );
  });
});
