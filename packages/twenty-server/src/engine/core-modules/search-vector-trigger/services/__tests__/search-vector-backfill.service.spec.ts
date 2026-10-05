import { FieldMetadataType } from 'twenty-shared/types';

import { type SearchVectorBackfillJobStatus } from 'src/engine/core-modules/search-vector-trigger/entities/search-vector-backfill-job.entity';
import {
  SEARCH_VECTOR_BACKFILL_MAX_ATTEMPTS,
  SearchVectorBackfillService,
} from 'src/engine/core-modules/search-vector-trigger/services/search-vector-backfill.service';

const JOB = {
  id: 'job-id',
  workspaceId: '20202020-0000-4000-8000-000000000001',
  objectMetadataId: 'object-id',
  filter: null as { fieldMetadataId: string; optionValues?: string[] } | null,
  cursor: null as string | null,
  status: 'RUNNING' as SearchVectorBackfillJobStatus,
  generation: 3,
};

const flatObjectMetadataMaps = {
  universalIdentifierById: { 'object-id': 'object' },
  byUniversalIdentifier: {
    object: {
      id: 'object-id',
      nameSingular: 'svItem',
      applicationUniversalIdentifier: 'custom-application',
    },
  },
};

type BatchScenario = {
  job?: Partial<typeof JOB> | null;
  isTriggerMode?: boolean;
  windowRowCount?: number;
  touchedRowCount?: number;
  isClaimLockFree?: boolean;
  flatFieldMetadatas?: Array<{
    id: string;
    name: string;
    type: FieldMetadataType;
    objectMetadataId: string;
  }>;
  isJobStillCurrent?: boolean;
  batchError?: Error;
  failureStatus?: 'RETRYABLE' | 'FAILED';
};

const buildService = ({
  job = {},
  isTriggerMode = true,
  windowRowCount = 1000,
  touchedRowCount = 2,
  isClaimLockFree = true,
  flatFieldMetadatas = [],
  isJobStillCurrent = true,
  batchError,
  failureStatus = 'RETRYABLE',
}: BatchScenario) => {
  const jobUpdates: Array<{ sql: string; parameters: unknown[] }> = [];

  const updateJob = (sql: string, parameters: unknown[]) => {
    jobUpdates.push({ sql, parameters });

    if (sql.includes(`"attempts" + 1`)) {
      return { records: [{ status: failureStatus }] };
    }

    return { records: isJobStillCurrent ? [{ id: JOB.id }] : [] };
  };

  const queryRunner = {
    isTransactionActive: false,
    connect: jest.fn(),
    startTransaction: jest.fn(async () => {
      queryRunner.isTransactionActive = true;
    }),
    commitTransaction: jest.fn(async () => {
      queryRunner.isTransactionActive = false;
    }),
    rollbackTransaction: jest.fn(async () => {
      queryRunner.isTransactionActive = false;
    }),
    release: jest.fn(),
    query: jest.fn(async (sql: string, parameters: unknown[]) => {
      if (sql.startsWith('UPDATE core."searchVectorBackfillJob"')) {
        return updateJob(sql, parameters);
      }
      if (sql.includes('a.attgenerated')) {
        return [{ attgenerated: isTriggerMode ? '' : 's' }];
      }
      if (sql.includes('pg_trigger')) {
        return [{ exists: true }];
      }
      if (sql.includes('WITH "batchWindow"')) {
        if (batchError) {
          throw batchError;
        }

        return [
          {
            windowRowCount,
            touchedRowCount,
            lastId: windowRowCount > 0 ? 'last-window-id' : null,
          },
        ];
      }
      if (sql.includes('pg_try_advisory_xact_lock')) {
        return [{ isLocked: isClaimLockFree }];
      }
      if (sql.includes('ORDER BY "createdAt"')) {
        return job === null ? [] : [{ ...JOB, ...job }];
      }

      return [];
    }),
  };

  const dataSource = {
    createQueryRunner: jest.fn(() => queryRunner),
    query: jest.fn(async () => (job === null ? [] : [{ ...JOB, ...job }])),
  };
  const exceptionHandlerService = { captureExceptions: jest.fn() };

  const service = new SearchVectorBackfillService(
    dataSource as never,
    {
      getOrRecompute: jest.fn(async () => ({
        flatObjectMetadataMaps,
        flatFieldMetadataMaps: {
          universalIdentifierById: Object.fromEntries(
            flatFieldMetadatas.map((field) => [field.id, field.id]),
          ),
          byUniversalIdentifier: Object.fromEntries(
            flatFieldMetadatas.map((field) => [field.id, field]),
          ),
        },
      })),
    } as never,
    exceptionHandlerService as never,
  );

  return { service, queryRunner, jobUpdates, exceptionHandlerService };
};

const runBatch = (service: SearchVectorBackfillService) =>
  service.runBatch({ jobId: JOB.id, generation: JOB.generation });

describe('SearchVectorBackfillService.runBatch', () => {
  it('should touch the next rows, move the cursor and ask for another batch', async () => {
    const { service, queryRunner, jobUpdates } = buildService({});

    expect(await runBatch(service)).toBe(false);

    expect(queryRunner.query).toHaveBeenCalledWith(
      `SET LOCAL statement_timeout = '8s'`,
    );
    const [advance] = jobUpdates;

    expect(advance.sql).toContain(`"cursor" = $3`);
    expect(advance.sql).toContain(`"generation" = $2 AND "status" = 'RUNNING'`);
    expect(advance.parameters).toEqual([
      JOB.id,
      JOB.generation,
      'last-window-id',
      2,
      null,
    ]);
    expect(queryRunner.commitTransaction).toHaveBeenCalled();
  });

  it('should continue from the cursor and read the cutoff from the job row', async () => {
    const { service, queryRunner } = buildService({
      job: { cursor: 'cursor-id' },
    });

    await runBatch(service);

    const batchCall = queryRunner.query.mock.calls.find(([sql]) =>
      sql.includes('WITH "batchWindow"'),
    );

    expect(batchCall?.[0]).toContain(`WHERE "id" > $1`);
    expect(batchCall?.[0]).toContain(
      `"createdAt" <= (SELECT "cutoffAt" FROM core."searchVectorBackfillJob" WHERE "id" = $2)`,
    );
    expect(batchCall?.[1]).toEqual(['cursor-id', JOB.id]);
  });

  it('should move past a window where the filter matched no row', async () => {
    const { service, queryRunner, jobUpdates } = buildService({
      touchedRowCount: 0,
    });

    expect(await runBatch(service)).toBe(false);
    expect(jobUpdates[0].sql).toContain(`"cursor" = $3`);
    expect(jobUpdates[0].parameters.slice(2, 4)).toEqual(['last-window-id', 0]);

    // The filter only narrows rows inside the window; the cursor follows the window itself.
    const [batchSql] = queryRunner.query.mock.calls.find(([sql]) =>
      sql.includes('WITH "batchWindow"'),
    ) ?? [''];

    expect(batchSql).toContain(
      `WHERE "id" IN (SELECT "id" FROM "batchWindow")`,
    );
    expect(batchSql).toContain(
      `(SELECT "id" FROM "batchWindow" ORDER BY "id" DESC LIMIT 1) AS "lastId"`,
    );
  });

  it('should only save the cursor if no other message moved it first', async () => {
    const { service, jobUpdates } = buildService({
      job: { cursor: 'cursor-id' },
    });

    await runBatch(service);

    expect(jobUpdates[0].sql).toContain(`"cursor" IS NOT DISTINCT FROM $5`);
    expect(jobUpdates[0].parameters[4]).toBe('cursor-id');
  });

  it('should complete the job when no rows are left', async () => {
    const { service, jobUpdates } = buildService({
      windowRowCount: 0,
      touchedRowCount: 0,
    });

    expect(await runBatch(service)).toBe(true);
    expect(jobUpdates[0].sql).toContain(`"status" = 'COMPLETED'`);
    expect(jobUpdates[0].parameters[2]).toBeNull();
  });

  it('should roll the batch back when the job was reset while it ran', async () => {
    const { service, queryRunner } = buildService({
      isJobStillCurrent: false,
    });

    expect(await runBatch(service)).toBe(true);
    expect(queryRunner.rollbackTransaction).toHaveBeenCalled();
    expect(queryRunner.commitTransaction).not.toHaveBeenCalled();
  });

  it('should ignore a message from an older claim', async () => {
    const { service, queryRunner } = buildService({ job: { generation: 4 } });

    expect(await runBatch(service)).toBe(true);
    expect(queryRunner.startTransaction).not.toHaveBeenCalled();
  });

  it('should complete with a note when the table is no longer in trigger mode', async () => {
    const { service, jobUpdates, queryRunner } = buildService({
      isTriggerMode: false,
    });

    expect(await runBatch(service)).toBe(true);
    expect(jobUpdates[0].sql).toContain(`"status" = 'COMPLETED'`);
    expect(jobUpdates[0].parameters[2]).toContain('Nothing to backfill');
    expect(
      queryRunner.query.mock.calls.some(([sql]) =>
        sql.includes('WITH "batchWindow"'),
      ),
    ).toBe(false);
  });

  it('should make a failed batch retryable and keep it out of Sentry', async () => {
    const { service, queryRunner, jobUpdates, exceptionHandlerService } =
      buildService({ batchError: new Error('canceling statement') });

    expect(await runBatch(service)).toBe(true);
    expect(queryRunner.rollbackTransaction).toHaveBeenCalled();
    expect(jobUpdates[0].sql).toContain(
      `WHEN "attempts" + 1 >= $3 THEN 'FAILED' ELSE 'RETRYABLE'`,
    );
    expect(jobUpdates[0].parameters).toEqual([
      JOB.id,
      JOB.generation,
      SEARCH_VECTOR_BACKFILL_MAX_ATTEMPTS,
      'canceling statement',
    ]);
    expect(exceptionHandlerService.captureExceptions).not.toHaveBeenCalled();
  });

  it('should report a job that ran out of attempts', async () => {
    const { service, exceptionHandlerService } = buildService({
      batchError: new Error('canceling statement'),
      failureStatus: 'FAILED',
    });

    await runBatch(service);

    expect(exceptionHandlerService.captureExceptions).toHaveBeenCalledTimes(1);
  });
});

describe('SearchVectorBackfillService.claimRunnableJobs', () => {
  it('should claim with a new generation and start the cutoff when the run starts', async () => {
    const { service, queryRunner } = buildService({
      job: { status: 'PENDING' },
    });

    queryRunner.query.mockImplementation(async (sql: string) => {
      if (sql.includes('pg_try_advisory_xact_lock')) {
        return [{ isLocked: true }];
      }
      if (sql.includes('ORDER BY "createdAt"')) {
        return [{ ...JOB, status: 'PENDING' }];
      }

      return { records: [{ id: JOB.id, generation: JOB.generation + 1 }] };
    });

    expect(await service.claimRunnableJobs()).toEqual([
      { jobId: JOB.id, generation: JOB.generation + 1 },
    ]);

    const [claimSql, claimParameters] = queryRunner.query.mock.calls[2];

    expect(claimSql).toContain(`"generation" = "generation" + 1`);
    expect(claimSql).toContain(
      `"cutoffAt" = CASE WHEN "cursor" IS NULL THEN now() ELSE "cutoffAt" END`,
    );
    expect(claimParameters).toEqual([JOB.id, 'PENDING', JOB.generation]);
    expect(queryRunner.commitTransaction).toHaveBeenCalled();
  });

  it('should claim nothing while another reconcile run holds the lock', async () => {
    const { service, queryRunner } = buildService({
      job: { status: 'PENDING' },
      isClaimLockFree: false,
    });

    expect(await service.claimRunnableJobs()).toEqual([]);
    expect(queryRunner.query).toHaveBeenCalledTimes(1);
    expect(queryRunner.rollbackTransaction).toHaveBeenCalled();
  });
});

describe('SearchVectorBackfillService.reportStuckJobs', () => {
  it('should report each stuck job under one fixed message with its ids as context', async () => {
    const { service, exceptionHandlerService } = buildService({
      job: { status: 'RUNNING' },
    });

    await service.reportStuckJobs();

    expect(exceptionHandlerService.captureExceptions).toHaveBeenCalledWith(
      [new Error('Search vector backfill job is stuck')],
      {
        workspace: { id: JOB.workspaceId },
        additionalData: {
          jobId: JOB.id,
          objectMetadataId: JOB.objectMetadataId,
          status: 'RUNNING',
        },
      },
    );
  });
});

describe('SearchVectorBackfillService.resolveBatchTarget', () => {
  const field = (name: string, type: FieldMetadataType) => ({
    id: `${name}-id`,
    name,
    type,
    objectMetadataId: JOB.objectMetadataId,
  });

  const buildFilterSql = async ({
    filter,
    flatFieldMetadatas,
  }: {
    filter: typeof JOB.filter;
    flatFieldMetadatas: ReturnType<typeof field>[];
  }) => {
    const { service } = buildService({ flatFieldMetadatas });
    const target = await service['resolveBatchTarget']({ ...JOB, filter });
    const parameters: unknown[] = ['earlier-parameter'];

    const filterSql = target?.buildFilterSql((value) => {
      parameters.push(value);

      return `$${parameters.length}`;
    });

    return { target, filterSql, parameters };
  };

  it('should narrow a select or multi-select field to its option values', async () => {
    const select = await buildFilterSql({
      filter: { fieldMetadataId: 'tier-id', optionValues: ['GOLD'] },
      flatFieldMetadatas: [field('tier', FieldMetadataType.SELECT)],
    });

    expect(select.target).toMatchObject({ tableName: '_svItem' });
    expect(select.filterSql).toBe(`"tier"::text = ANY($2::text[])`);
    expect(select.parameters).toEqual(['earlier-parameter', ['GOLD']]);

    const multiSelect = await buildFilterSql({
      filter: { fieldMetadataId: 'tags-id', optionValues: ['A', 'B'] },
      flatFieldMetadatas: [field('tags', FieldMetadataType.MULTI_SELECT)],
    });

    expect(multiSelect.filterSql).toBe(`"tags"::text[] && $2::text[]`);
    expect(multiSelect.parameters).toEqual(['earlier-parameter', ['A', 'B']]);
  });

  it('should find phone rows holding only a calling code', async () => {
    const { filterSql, parameters } = await buildFilterSql({
      filter: { fieldMetadataId: 'phones-id' },
      flatFieldMetadatas: [field('phones', FieldMetadataType.PHONES)],
    });

    expect(filterSql).toContain(`"phonesPrimaryPhoneNumber"`);
    expect(filterSql).toContain(`"phonesPrimaryPhoneCallingCode"`);
    expect(filterSql).toContain(`"phonesAdditionalPhones"`);
    expect(filterSql).not.toContain(`"phonesPrimaryPhoneCountryCode"`);
    expect(parameters).toEqual(['earlier-parameter']);
  });

  it('should cover the whole table when the filtered field is gone', async () => {
    const { filterSql } = await buildFilterSql({
      filter: { fieldMetadataId: 'deleted-id' },
      flatFieldMetadatas: [],
    });

    expect(filterSql).toBe('TRUE');
  });
});
