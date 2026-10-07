import { isDefined } from 'twenty-shared/utils';
import { type DataSource, type QueryRunner } from 'typeorm';

import { escapeIdentifier } from 'src/engine/workspace-manager/workspace-migration/utils/remove-sql-injection.util';

type SearchVectorColumnState = 'generated' | 'plain' | 'missing';

type TimeoutAdjustableQueryRunner = QueryRunner & {
  databaseConnection?: {
    query_timeout?: number;
    connectionParameters?: { query_timeout?: number };
  };
};

export const MISMATCH_CHECK_STATEMENT_TIMEOUT = '30min';
const CLIENT_QUERY_TIMEOUT_MS = 35 * 60 * 1000;

// The pg client timer only rejects the promise and never cancels the server query, so the
// client limit is raised here and the server-side statement_timeout does the cancelling.
const raiseClientQueryTimeout = (
  queryRunner: QueryRunner,
  clientQueryTimeoutMs: number,
): (() => void) => {
  const databaseConnection = (queryRunner as TimeoutAdjustableQueryRunner)
    .databaseConnection;

  if (!isDefined(databaseConnection)) {
    return () => {};
  }

  const originalQueryTimeout = databaseConnection.query_timeout;
  const connectionParameters = databaseConnection.connectionParameters;
  const originalParameterTimeout = connectionParameters?.query_timeout;

  databaseConnection.query_timeout = clientQueryTimeoutMs;
  if (isDefined(connectionParameters)) {
    connectionParameters.query_timeout = clientQueryTimeoutMs;
  }

  return () => {
    databaseConnection.query_timeout = originalQueryTimeout;
    if (isDefined(connectionParameters)) {
      connectionParameters.query_timeout = originalParameterTimeout;
    }
  };
};

// A whole-table scan can outlast the client's default query timeout. 0 removes the client
// limit, for an index build that must not be reported failed while the server still runs it.
export const withLongQueryRunner = async <TResult>(
  dataSource: DataSource,
  callback: (queryRunner: QueryRunner) => Promise<TResult>,
  clientQueryTimeoutMs = CLIENT_QUERY_TIMEOUT_MS,
): Promise<TResult> => {
  const queryRunner = dataSource.createQueryRunner();
  let restoreClientTimeout: () => void = () => {};

  try {
    await queryRunner.connect();
    restoreClientTimeout = raiseClientQueryTimeout(
      queryRunner,
      clientQueryTimeoutMs,
    );

    return await callback(queryRunner);
  } finally {
    restoreClientTimeout();
    await queryRunner.release();
  }
};

export const selectMismatchCount = async (
  queryRunner: QueryRunner,
  qualifiedTable: string,
  leanColumnExpression: string,
): Promise<number> => {
  const [{ mismatchCount }] = (await queryRunner.query(
    `SELECT count(*) FILTER (WHERE "searchVector" IS DISTINCT FROM (${leanColumnExpression}))::int AS "mismatchCount" FROM ${qualifiedTable}`,
  )) as Array<{ mismatchCount: number }>;

  return mismatchCount;
};

// Read only, in its own transaction, so the scan takes no lock beyond reading.
export const countSearchVectorMismatches = async (
  queryRunner: QueryRunner,
  qualifiedTable: string,
  leanColumnExpression: string,
): Promise<number> => {
  await queryRunner.startTransaction();

  try {
    await queryRunner.query(`SET TRANSACTION READ ONLY`);
    await queryRunner.query(
      `SET LOCAL statement_timeout = '${MISMATCH_CHECK_STATEMENT_TIMEOUT}'`,
    );
    const mismatchCount = await selectMismatchCount(
      queryRunner,
      qualifiedTable,
      leanColumnExpression,
    );

    await queryRunner.commitTransaction();

    return mismatchCount;
  } catch (error) {
    try {
      await queryRunner.rollbackTransaction();
    } catch {
      // Keep the original error.
    }
    throw error;
  }
};

// BEFORE (2) | ROW (1) | INSERT (4) | UPDATE (16), as created by buildSearchVectorTriggerStatements.
const SEARCH_VECTOR_TRIGGER_TYPE = 23;

// A disabled trigger, or a same-named one calling another function, does not maintain the
// column, so only the exact trigger counts.
export const hasSearchVectorTrigger = async (
  queryRunner: QueryRunner,
  {
    qualifiedTable,
    triggerName,
    qualifiedFunction,
  }: { qualifiedTable: string; triggerName: string; qualifiedFunction: string },
): Promise<boolean> => {
  const [{ exists }] = (await queryRunner.query(
    `SELECT EXISTS (
       SELECT 1 FROM pg_trigger
        WHERE tgrelid = $1::regclass
          AND tgname = $2
          AND NOT tgisinternal
          AND tgenabled <> 'D'
          AND tgtype = $3
          AND tgfoid = to_regprocedure($4 || '()')
     ) AS "exists"`,
    [
      qualifiedTable,
      triggerName,
      SEARCH_VECTOR_TRIGGER_TYPE,
      qualifiedFunction,
    ],
  )) as Array<{ exists: boolean }>;

  return exists;
};

export const getSearchVectorColumnState = async (
  queryRunner: QueryRunner,
  schemaName: string,
  tableName: string,
): Promise<SearchVectorColumnState> => {
  const rows = (await queryRunner.query(
    `SELECT a.attgenerated
       FROM pg_attribute a
       JOIN pg_class c ON c.oid = a.attrelid
       JOIN pg_namespace n ON n.oid = c.relnamespace
      WHERE n.nspname = $1 AND c.relname = $2 AND a.attname = 'searchVector' AND NOT a.attisdropped`,
    [schemaName, tableName],
  )) as Array<{ attgenerated: string }>;

  if (rows.length === 0) {
    return 'missing';
  }

  const { attgenerated } = rows[0];

  if (attgenerated === '') {
    return 'plain';
  }

  if (attgenerated === 's') {
    return 'generated';
  }

  // PG18 adds virtual generated columns ('v'); converting one needs its own path.
  throw new Error(
    `Unsupported searchVector attgenerated value '${attgenerated}' on ${schemaName}.${tableName}`,
  );
};

export const selectRowCount = async (
  queryRunner: QueryRunner,
  qualifiedTable: string,
): Promise<number> => {
  const [{ rowCount }] = (await queryRunner.query(
    `SELECT count(*)::int AS "rowCount" FROM ${qualifiedTable}`,
  )) as Array<{ rowCount: number }>;

  return rowCount;
};

export type SearchVectorIndexHealth =
  | 'healthy'
  | 'missing'
  | 'invalid'
  | 'wrongDefinition';

type SearchVectorIndex = {
  indexName: string;
  isReady: boolean;
  hasExpectedDefinition: boolean;
};

// Every index reading searchVector, compared with the plain one-column GIN Twenty creates.
const readSearchVectorIndexes = async (
  queryRunner: QueryRunner,
  qualifiedTable: string,
): Promise<SearchVectorIndex[]> =>
  (await queryRunner.query(
    `SELECT ic.relname AS "indexName",
            (i.indisvalid AND i.indisready AND i.indislive) AS "isReady",
            (am.amname = 'gin' AND i.indnatts = 1 AND i.indexprs IS NULL
              AND i.indpred IS NULL AND NOT i.indisunique) AS "hasExpectedDefinition"
       FROM pg_index i
       JOIN pg_class ic ON ic.oid = i.indexrelid
       JOIN pg_am am ON am.oid = ic.relam
       JOIN pg_attribute a ON a.attrelid = i.indrelid
        AND a.attname = 'searchVector' AND NOT a.attisdropped
      WHERE i.indrelid = $1::regclass AND a.attnum = ANY(i.indkey)`,
    [qualifiedTable],
  )) as SearchVectorIndex[];

const toSearchVectorIndexHealth = (
  indexes: SearchVectorIndex[],
): SearchVectorIndexHealth => {
  if (indexes.some((index) => index.isReady && index.hasExpectedDefinition)) {
    return 'healthy';
  }

  if (indexes.some((index) => index.hasExpectedDefinition)) {
    return 'invalid';
  }

  return indexes.length > 0 ? 'wrongDefinition' : 'missing';
};

// Search does not fail without a usable GIN, it scans the whole table, so this is checked apart.
export const readSearchVectorIndexHealth = async (
  queryRunner: QueryRunner,
  qualifiedTable: string,
): Promise<SearchVectorIndexHealth> =>
  toSearchVectorIndexHealth(
    await readSearchVectorIndexes(queryRunner, qualifiedTable),
  );

// Leftovers of an interrupted rebuild: our temporary index, or REINDEX CONCURRENTLY's copies.
const isLeftoverRebuildIndex = (indexName: string, candidateName: string) =>
  candidateName === `${indexName}_repair` ||
  candidateName.startsWith(`${indexName}_ccnew`);

// CONCURRENTLY keeps reads and writes going, and cannot run inside a transaction.
const repairSearchVectorIndex = async (
  queryRunner: QueryRunner,
  {
    schemaName,
    qualifiedTable,
    indexName,
    indexes,
  }: {
    schemaName: string;
    qualifiedTable: string;
    indexName: string;
    indexes: SearchVectorIndex[];
  },
): Promise<void> => {
  const qualifyIndex = (name: string) =>
    `${escapeIdentifier(schemaName)}.${escapeIdentifier(name)}`;
  const createIndex = (name: string) =>
    queryRunner.query(
      `CREATE INDEX CONCURRENTLY ${escapeIdentifier(name)} ON ${qualifiedTable} USING gin ("searchVector")`,
    );

  for (const leftoverIndex of indexes.filter((index) =>
    isLeftoverRebuildIndex(indexName, index.indexName),
  )) {
    await queryRunner.query(
      `DROP INDEX CONCURRENTLY IF EXISTS ${qualifyIndex(leftoverIndex.indexName)}`,
    );
  }

  const existingIndex = indexes.find((index) => index.indexName === indexName);

  if (!isDefined(existingIndex)) {
    await createIndex(indexName);

    return;
  }

  if (!existingIndex.hasExpectedDefinition) {
    // Built under a temporary name first, so search keeps an index while the wrong one goes.
    const temporaryIndexName = `${indexName}_repair`;

    await createIndex(temporaryIndexName);
    await queryRunner.query(
      `DROP INDEX CONCURRENTLY ${qualifyIndex(indexName)}`,
    );
    await queryRunner.query(
      `ALTER INDEX ${qualifyIndex(temporaryIndexName)} RENAME TO ${escapeIdentifier(indexName)}`,
    );

    return;
  }

  if (!existingIndex.isReady) {
    await queryRunner.query(
      `REINDEX INDEX CONCURRENTLY ${qualifyIndex(indexName)}`,
    );
  }
};

// Without a name every index reading searchVector counts. With the name from metadata only that
// index counts, a rebuild keeps it, and leftovers of an interrupted rebuild need a repair too.
export const checkSearchVectorIndex = async (
  queryRunner: QueryRunner,
  {
    schemaName,
    qualifiedTable,
    indexName,
    repair,
  }: {
    schemaName: string;
    qualifiedTable: string;
    indexName?: string;
    repair: boolean;
  },
): Promise<SearchVectorIndexHealth | 'repaired'> => {
  const readHealth = async () => {
    const indexes = await readSearchVectorIndexes(queryRunner, qualifiedTable);

    if (!isDefined(indexName)) {
      return { indexes, health: toSearchVectorIndexHealth(indexes) };
    }

    const health = toSearchVectorIndexHealth(
      indexes.filter((index) => index.indexName === indexName),
    );
    const hasLeftover = indexes.some((index) =>
      isLeftoverRebuildIndex(indexName, index.indexName),
    );

    return {
      indexes,
      health: health === 'healthy' && hasLeftover ? 'invalid' : health,
    };
  };

  const { indexes, health } = await readHealth();

  if (health === 'healthy' || !repair || !isDefined(indexName)) {
    return health;
  }

  await repairSearchVectorIndex(queryRunner, {
    schemaName,
    qualifiedTable,
    indexName,
    indexes,
  });

  const { health: repairedHealth } = await readHealth();

  return repairedHealth === 'healthy' ? 'repaired' : repairedHealth;
};
