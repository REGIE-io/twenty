import { checkSearchVectorIndex } from 'src/engine/core-modules/search-vector-trigger/utils/search-vector-table-queries.util';

type IndexRow = {
  indexName: string;
  isReady: boolean;
  hasExpectedDefinition: boolean;
};

const HEALTHY = { isReady: true, hasExpectedDefinition: true };

// Each catalog read returns the next state, so a repair can be followed by its recheck.
const buildQueryRunner = (indexReads: IndexRow[][]) => {
  const query = jest.fn(async (sql: string) =>
    sql.includes('pg_index') ? (indexReads.shift() ?? []) : [],
  );

  return { queryRunner: { query } as never, query };
};

const statements = (query: jest.Mock) =>
  query.mock.calls
    .map(([sql]) => sql as string)
    .filter((sql) => !sql.includes('pg_index'));

const check = (queryRunner: never, repair: boolean, indexName?: string) =>
  checkSearchVectorIndex(queryRunner, {
    schemaName: 'workspace_abc',
    qualifiedTable: '"workspace_abc"."person"',
    indexName,
    repair,
  });

describe('checkSearchVectorIndex', () => {
  it('counts any healthy index when no metadata name is known', async () => {
    const { queryRunner } = buildQueryRunner([
      [{ indexName: 'IDX_other', ...HEALTHY }],
    ]);

    await expect(check(queryRunner, true)).resolves.toBe('healthy');
  });

  it('judges only the index under its metadata name', async () => {
    const { queryRunner, query } = buildQueryRunner([
      [{ indexName: 'IDX_other', ...HEALTHY }],
    ]);

    await expect(check(queryRunner, false, 'IDX_person')).resolves.toBe(
      'missing',
    );
    expect(statements(query)).toEqual([]);
  });

  it('creates a missing index concurrently under its metadata name', async () => {
    const { queryRunner, query } = buildQueryRunner([
      [],
      [{ indexName: 'IDX_person', ...HEALTHY }],
    ]);

    await expect(check(queryRunner, true, 'IDX_person')).resolves.toBe(
      'repaired',
    );
    expect(statements(query)).toEqual([
      'CREATE INDEX CONCURRENTLY "IDX_person" ON "workspace_abc"."person" USING gin ("searchVector")',
    ]);
  });

  it('reindexes an invalid index in place', async () => {
    const { queryRunner, query } = buildQueryRunner([
      [
        {
          indexName: 'IDX_person',
          isReady: false,
          hasExpectedDefinition: true,
        },
      ],
      [{ indexName: 'IDX_person', ...HEALTHY }],
    ]);

    await expect(check(queryRunner, true, 'IDX_person')).resolves.toBe(
      'repaired',
    );
    expect(statements(query)).toEqual([
      'REINDEX INDEX CONCURRENTLY "workspace_abc"."IDX_person"',
    ]);
  });

  it('builds a wrongly defined index aside, then swaps it in under the same name', async () => {
    const { queryRunner, query } = buildQueryRunner([
      [
        {
          indexName: 'IDX_person',
          isReady: true,
          hasExpectedDefinition: false,
        },
      ],
      [{ indexName: 'IDX_person', ...HEALTHY }],
    ]);

    await expect(check(queryRunner, true, 'IDX_person')).resolves.toBe(
      'repaired',
    );
    expect(statements(query)).toEqual([
      'CREATE INDEX CONCURRENTLY "IDX_person_repair" ON "workspace_abc"."person" USING gin ("searchVector")',
      'DROP INDEX CONCURRENTLY "workspace_abc"."IDX_person"',
      'ALTER INDEX "workspace_abc"."IDX_person_repair" RENAME TO "IDX_person"',
    ]);
  });

  it('drops leftovers of an interrupted rebuild even when the named index is healthy', async () => {
    const { queryRunner, query } = buildQueryRunner([
      [
        { indexName: 'IDX_person', ...HEALTHY },
        { indexName: 'IDX_person_repair', ...HEALTHY },
        {
          indexName: 'IDX_person_ccnew1',
          isReady: false,
          hasExpectedDefinition: true,
        },
      ],
      [{ indexName: 'IDX_person', ...HEALTHY }],
    ]);

    await expect(check(queryRunner, true, 'IDX_person')).resolves.toBe(
      'repaired',
    );
    expect(statements(query)).toEqual([
      'DROP INDEX CONCURRENTLY IF EXISTS "workspace_abc"."IDX_person_repair"',
      'DROP INDEX CONCURRENTLY IF EXISTS "workspace_abc"."IDX_person_ccnew1"',
    ]);
  });
});
