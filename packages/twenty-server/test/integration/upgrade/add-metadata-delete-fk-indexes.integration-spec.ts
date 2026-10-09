import { AddMetadataDeleteForeignKeyIndexesSlowInstanceCommand } from 'src/database/commands/upgrade-version-command/2-32/2-32-instance-command-slow-1791540000000-add-metadata-delete-fk-indexes';

jest.setTimeout(60_000);

const INDEX_NAMES = [
  'IDX_SEARCH_FIELD_METADATA_FIELD_METADATA_ID',
  'IDX_SEARCH_FIELD_METADATA_TS_VECTOR_FIELD_METADATA_ID',
  'IDX_INDEX_FIELD_METADATA_INDEX_METADATA_ID',
  'IDX_FIELD_METADATA_APPLICATION_ID',
];

const readValidIndexes = async (): Promise<string[]> => {
  const rows: { relname: string }[] = await global.testDataSource.query(
    `SELECT c.relname FROM pg_index i JOIN pg_class c ON c.oid = i.indexrelid
    WHERE c.relnamespace = 'core'::regnamespace AND c.relname = ANY($1) AND i.indisvalid`,
    [INDEX_NAMES],
  );

  return rows.map(({ relname }) => relname).sort();
};

describe('AddMetadataDeleteForeignKeyIndexesSlowInstanceCommand', () => {
  const command = new AddMetadataDeleteForeignKeyIndexesSlowInstanceCommand();

  const runUp = async () => {
    const queryRunner = global.testDataSource.createQueryRunner();

    await queryRunner.connect();
    try {
      await queryRunner.startTransaction();
      await command.up(queryRunner);
      await queryRunner.commitTransaction();
    } finally {
      await queryRunner.release();
    }
  };

  const runDown = async () => {
    const queryRunner = global.testDataSource.createQueryRunner();

    await queryRunner.connect();
    try {
      await command.down(queryRunner);
    } finally {
      await queryRunner.release();
    }
  };

  afterAll(async () => {
    await command.runDataMigration(global.testDataSource);
  });

  it('builds every foreign key index concurrently, and running it again changes nothing', async () => {
    await runDown();
    expect(await readValidIndexes()).toEqual([]);

    await command.runDataMigration(global.testDataSource);
    await runUp();
    expect(await readValidIndexes()).toEqual([...INDEX_NAMES].sort());

    await command.runDataMigration(global.testDataSource);
    await runUp();
    expect(await readValidIndexes()).toEqual([...INDEX_NAMES].sort());
  });

  it('creates the indexes in up alone, for a database that skipped the data migration', async () => {
    await runDown();
    await runUp();

    expect(await readValidIndexes()).toEqual([...INDEX_NAMES].sort());
  });

  it('lets a workspace delete find the rows that reference its metadata by index', async () => {
    const plans: { 'QUERY PLAN': string }[][] = await Promise.all(
      [
        `SELECT 1 FROM core."searchFieldMetadata" WHERE "fieldMetadataId" = '00000000-0000-4000-8000-000000000000'`,
        `SELECT 1 FROM core."searchFieldMetadata" WHERE "tsVectorFieldMetadataId" = '00000000-0000-4000-8000-000000000000'`,
        `SELECT 1 FROM core."indexFieldMetadata" WHERE "indexMetadataId" = '00000000-0000-4000-8000-000000000000'`,
        `SELECT 1 FROM core."fieldMetadata" WHERE "applicationId" = '00000000-0000-4000-8000-000000000000'`,
      ].map(async (sql) => {
        const queryRunner = global.testDataSource.createQueryRunner();

        await queryRunner.connect();
        try {
          await queryRunner.query('SET enable_seqscan = off');

          return await queryRunner.query(`EXPLAIN ${sql}`);
        } finally {
          await queryRunner.query('RESET enable_seqscan');
          await queryRunner.release();
        }
      }),
    );

    plans.forEach((plan, position) => {
      expect(plan.map((row) => row['QUERY PLAN']).join('\n')).toContain(
        INDEX_NAMES[position],
      );
    });
  });
});
