import { type DataSource } from 'typeorm';

// Data migrations in slow instance commands can outlive the columns they read:
// a later command may drop or rename the source column, which permanently wedges
// the upgrade sequence because the failed step is retried forever from the same
// cursor. Guarding on the source column lets an already-applied backfill no-op.
//
// pg_attribute scoped to the single table, not the instance-wide
// information_schema.columns view, which is slow on many-tenant instances.
export const columnExists = async ({
  dataSource,
  schemaName,
  tableName,
  columnName,
}: {
  dataSource: DataSource;
  schemaName: string;
  tableName: string;
  columnName: string;
}): Promise<boolean> => {
  const rows = await dataSource.query(
    `SELECT EXISTS (
      SELECT 1 FROM pg_attribute
      WHERE attrelid = to_regclass($1)
        AND attname = $2
        AND NOT attisdropped
        AND attnum > 0
    ) AS "exists"`,
    [`"${schemaName}"."${tableName}"`, columnName],
  );

  return rows[0]?.exists === true;
};
