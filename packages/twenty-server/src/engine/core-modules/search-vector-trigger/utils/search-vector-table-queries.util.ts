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

export const hasSearchVectorTrigger = async (
  queryRunner: QueryRunner,
  qualifiedTable: string,
  triggerName: string,
): Promise<boolean> => {
  const [{ exists }] = (await queryRunner.query(
    `SELECT EXISTS (
       SELECT 1 FROM pg_trigger
        WHERE tgrelid = $1::regclass AND tgname = $2 AND NOT tgisinternal
     ) AS "exists"`,
    [qualifiedTable, triggerName],
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
