import { type QueryRunner } from 'typeorm';

type SearchVectorColumnState = 'generated' | 'plain' | 'missing';

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
