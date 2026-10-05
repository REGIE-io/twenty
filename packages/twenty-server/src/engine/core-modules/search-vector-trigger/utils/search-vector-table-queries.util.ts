import { isDefined } from 'twenty-shared/utils';
import { type DataSource, type QueryRunner } from 'typeorm';

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
const raiseClientQueryTimeout = (queryRunner: QueryRunner): (() => void) => {
  const databaseConnection = (queryRunner as TimeoutAdjustableQueryRunner)
    .databaseConnection;

  if (!isDefined(databaseConnection)) {
    return () => {};
  }

  const originalQueryTimeout = databaseConnection.query_timeout;
  const connectionParameters = databaseConnection.connectionParameters;
  const originalParameterTimeout = connectionParameters?.query_timeout;

  databaseConnection.query_timeout = CLIENT_QUERY_TIMEOUT_MS;
  if (isDefined(connectionParameters)) {
    connectionParameters.query_timeout = CLIENT_QUERY_TIMEOUT_MS;
  }

  return () => {
    databaseConnection.query_timeout = originalQueryTimeout;
    if (isDefined(connectionParameters)) {
      connectionParameters.query_timeout = originalParameterTimeout;
    }
  };
};

// A whole-table scan can outlast the client's default query timeout.
export const withLongQueryRunner = async <TResult>(
  dataSource: DataSource,
  callback: (queryRunner: QueryRunner) => Promise<TResult>,
): Promise<TResult> => {
  const queryRunner = dataSource.createQueryRunner();
  let restoreClientTimeout: () => void = () => {};

  try {
    await queryRunner.connect();
    restoreClientTimeout = raiseClientQueryTimeout(queryRunner);

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

// The conversion cannot proceed without the column, so a missing one is an error.
export const getExistingSearchVectorColumnState = async (
  queryRunner: QueryRunner,
  { schemaName, tableName }: { schemaName: string; tableName: string },
): Promise<'generated' | 'plain'> => {
  const columnState = await getSearchVectorColumnState(
    queryRunner,
    schemaName,
    tableName,
  );

  if (columnState === 'missing') {
    throw new Error(
      `searchVector column not found on ${schemaName}.${tableName}`,
    );
  }

  return columnState;
};
