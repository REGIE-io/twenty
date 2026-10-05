import {
  createSearchVectorBackfillJobs,
  upsertSearchVectorBackfillJob,
} from 'src/engine/core-modules/search-vector-trigger/utils/search-vector-backfill.util';
import {
  refreshOrSelfHealSearchVectorTrigger,
  type SearchVectorTriggerSource,
} from 'src/engine/core-modules/search-vector-trigger/utils/search-vector-trigger-maintenance.util';
import { deriveCheckedSearchVectorExpression } from 'src/engine/metadata-modules/flat-search-field-metadata/utils/derive-checked-search-vector-expression.util';

jest.mock(
  'src/engine/core-modules/search-vector-trigger/utils/search-vector-backfill.util',
  () => ({
    createSearchVectorBackfillJobs: jest.fn(),
    upsertSearchVectorBackfillJob: jest.fn(),
  }),
);
jest.mock(
  'src/engine/metadata-modules/flat-search-field-metadata/utils/derive-checked-search-vector-expression.util',
  () => ({ deriveCheckedSearchVectorExpression: jest.fn() }),
);

const EXPRESSION = `to_tsvector('simple', COALESCE(new."name", ''))`;

// Answers the catalog reads the helpers make; every other statement returns nothing.
const buildSource = ({
  attgenerated,
  hasTrigger = false,
}: {
  attgenerated: 's' | '';
  hasTrigger?: boolean;
}) => {
  const query = jest.fn(async (sql: string) => {
    if (sql.includes('pg_attribute')) {
      return [{ attgenerated }];
    }

    if (sql.includes('pg_trigger')) {
      return [{ exists: hasTrigger }];
    }

    if (sql.includes('current_setting')) {
      return [{ search_path: 'public' }];
    }

    return [];
  });

  const source = {
    queryRunner: { query },
    schemaName: 'workspace_abc',
    tableName: '_item',
    flatObjectMetadata: { id: 'item-object-id', workspaceId: 'w1' },
    objectFlatFieldMetadatas: [],
    targetSearchFieldMetadatas: [],
  } as unknown as SearchVectorTriggerSource;

  return { source, query };
};

const executedStatements = (query: jest.Mock) =>
  query.mock.calls.map(([sql]) => sql as string);

describe('refreshOrSelfHealSearchVectorTrigger', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    jest
      .mocked(deriveCheckedSearchVectorExpression)
      .mockReturnValue(EXPRESSION);
  });

  it('switches a generated table in place and backfills it when the flag is on', async () => {
    const { source, query } = buildSource({ attgenerated: 's' });

    await expect(
      refreshOrSelfHealSearchVectorTrigger({
        source,
        backfillChange: { type: 'formula' },
        isSearchVectorTriggerEnabled: true,
      }),
    ).resolves.toBe(true);

    const statements = executedStatements(query);
    const createFunctionIndex = statements.findIndex((sql) =>
      sql.startsWith('CREATE OR REPLACE FUNCTION'),
    );
    const dropExpressionIndex = statements.findIndex((sql) =>
      sql.includes('DROP EXPRESSION'),
    );
    const createTriggerIndex = statements.findIndex((sql) =>
      sql.startsWith('CREATE TRIGGER'),
    );

    expect(createFunctionIndex).toBeGreaterThanOrEqual(0);
    expect(dropExpressionIndex).toBeGreaterThan(createFunctionIndex);
    expect(createTriggerIndex).toBeGreaterThan(dropExpressionIndex);
    expect(upsertSearchVectorBackfillJob).toHaveBeenCalledWith(
      source.queryRunner,
      {
        workspaceId: 'w1',
        objectMetadataId: 'item-object-id',
        request: { reason: 'REPAIR', filter: null },
      },
    );
  });

  it('leaves a generated table to the rebuild when the flag is off', async () => {
    const { source, query } = buildSource({ attgenerated: 's' });

    await expect(
      refreshOrSelfHealSearchVectorTrigger({
        source,
        isSearchVectorTriggerEnabled: false,
      }),
    ).resolves.toBe(false);

    expect(executedStatements(query)).toEqual([
      expect.stringContaining('pg_attribute'),
    ]);
    expect(upsertSearchVectorBackfillJob).not.toHaveBeenCalled();
  });

  it('only refreshes the function of a converted table', async () => {
    const { source, query } = buildSource({
      attgenerated: '',
      hasTrigger: true,
    });

    await expect(
      refreshOrSelfHealSearchVectorTrigger({
        source,
        backfillChange: { type: 'formula' },
        isSearchVectorTriggerEnabled: true,
      }),
    ).resolves.toBe(true);

    expect(
      executedStatements(query).some((sql) => sql.includes('DROP EXPRESSION')),
    ).toBe(false);
    expect(createSearchVectorBackfillJobs).toHaveBeenCalledWith({
      source,
      change: { type: 'formula' },
    });
    expect(upsertSearchVectorBackfillJob).not.toHaveBeenCalled();
  });
});
