import { type QueryRunner } from 'typeorm';

import { WorkspaceSchemaManagerException } from 'src/engine/twenty-orm/workspace-schema-manager/exceptions/workspace-schema-manager.exception';
import { WorkspaceSchemaTableManagerService } from 'src/engine/twenty-orm/workspace-schema-manager/services/workspace-schema-table-manager.service';

describe('WorkspaceSchemaTableManagerService', () => {
  let service: WorkspaceSchemaTableManagerService;
  let query: jest.Mock;
  let queryRunner: QueryRunner;

  beforeEach(() => {
    service = new WorkspaceSchemaTableManagerService();
    query = jest.fn();
    queryRunner = {
      query,
      isTransactionActive: true,
    } as unknown as QueryRunner;
  });

  describe('createTable', () => {
    it('issues a single CREATE TABLE statement', async () => {
      await service.createTable({
        queryRunner,
        schemaName: 'workspace_1',
        tableName: 'company',
      });

      expect(query).toHaveBeenCalledTimes(1);

      const sql = query.mock.calls[0][0] as string;

      expect(sql).toContain('CREATE TABLE IF NOT EXISTS');
      expect(sql).toContain('company');
      expect(sql).not.toContain(';');
    });
  });

  describe('createTables', () => {
    it('collapses many tables into one multi-statement round-trip', async () => {
      await service.createTables({
        queryRunner,
        schemaName: 'workspace_1',
        tables: [{ tableName: 'company' }, { tableName: 'person' }],
      });

      expect(query).toHaveBeenCalledTimes(1);

      const sql = query.mock.calls[0][0] as string;

      expect(sql).toContain('company');
      expect(sql).toContain('person');
      // Two statements joined by a single ';'
      expect(sql.split(';')).toHaveLength(2);
      // Each table with no columns still gets the default primary key.
      expect(sql).toContain('"id" uuid PRIMARY KEY DEFAULT gen_random_uuid()');
    });

    it('no-ops on empty input', async () => {
      await service.createTables({
        queryRunner,
        schemaName: 'workspace_1',
        tables: [],
      });

      expect(query).not.toHaveBeenCalled();
    });
  });

  describe('generated tsvector columns', () => {
    const searchVectorColumn = (asExpression?: string) => ({
      name: 'searchVector',
      type: 'tsvector',
      isNullable: true,
      isArray: false,
      default: null,
      asExpression,
      generatedType: 'STORED' as const,
      isPrimary: false,
    });

    it('emits the generated expression for a tsvector column', async () => {
      await service.createTables({
        queryRunner,
        schemaName: 'workspace_1',
        tables: [
          {
            tableName: 'person',
            columnDefinitions: [
              searchVectorColumn(
                "to_tsvector('simple', COALESCE(\"name\", ''))",
              ),
            ],
          },
        ],
      });

      expect(query.mock.calls[0][0]).toContain(
        `"searchVector" tsvector GENERATED ALWAYS AS (to_tsvector('simple', COALESCE("name", ''))) STORED`,
      );
    });

    it('creates a plain tsvector column that a search-vector trigger fills', async () => {
      await service.createTable({
        queryRunner,
        schemaName: 'workspace_1',
        tableName: 'person',
        columnDefinitions: [
          { ...searchVectorColumn(), isFilledByTrigger: true },
        ],
      });

      expect(query.mock.calls[0][0]).toContain(`"searchVector" tsvector`);
      expect(query.mock.calls[0][0]).not.toContain('GENERATED');
    });

    it('refuses to create a table whose tsvector column has no expression', async () => {
      await expect(
        service.createTable({
          queryRunner,
          schemaName: 'workspace_1',
          tableName: 'person',
          columnDefinitions: [searchVectorColumn()],
        }),
      ).rejects.toThrow(WorkspaceSchemaManagerException);

      expect(query).not.toHaveBeenCalled();
    });

    it('refuses the whole batch when any table has a tsvector column with no expression', async () => {
      await expect(
        service.createTables({
          queryRunner,
          schemaName: 'workspace_1',
          tables: [
            {
              tableName: 'company',
              columnDefinitions: [
                searchVectorColumn("to_tsvector('simple', '')"),
              ],
            },
            {
              tableName: 'person',
              columnDefinitions: [searchVectorColumn('')],
            },
          ],
        }),
      ).rejects.toThrow(/person.*searchVector/);

      expect(query).not.toHaveBeenCalled();
    });
  });
});
