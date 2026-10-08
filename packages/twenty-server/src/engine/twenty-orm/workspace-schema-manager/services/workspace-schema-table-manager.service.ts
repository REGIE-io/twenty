import { isNonEmptyString } from '@sniptt/guards';
import { type QueryRunner } from 'typeorm';

import {
  WorkspaceSchemaManagerException,
  WorkspaceSchemaManagerExceptionCode,
} from 'src/engine/twenty-orm/workspace-schema-manager/exceptions/workspace-schema-manager.exception';
import { type WorkspaceSchemaColumnDefinition } from 'src/engine/twenty-orm/workspace-schema-manager/types/workspace-schema-column-definition.type';
import { buildSqlColumnDefinition } from 'src/engine/twenty-orm/workspace-schema-manager/utils/build-sql-column-definition.util';
import { escapeIdentifier } from 'src/engine/workspace-manager/workspace-migration/utils/remove-sql-injection.util';

// A tsvector column without its expression is created as a plain column that is never
// populated, so search silently returns nothing. Fail the migration instead, unless a
// search-vector trigger fills the column.
const assertTsVectorColumnsHaveExpression = ({
  schemaName,
  tableName,
  columnDefinitions,
}: {
  schemaName: string;
  tableName: string;
  columnDefinitions: WorkspaceSchemaColumnDefinition[];
}): void => {
  const columnNamesMissingExpression = columnDefinitions
    .filter(
      (columnDefinition) =>
        columnDefinition.type === 'tsvector' &&
        columnDefinition.isFilledByTrigger !== true &&
        !isNonEmptyString(columnDefinition.asExpression),
    )
    .map((columnDefinition) => columnDefinition.name);

  if (columnNamesMissingExpression.length > 0) {
    throw new WorkspaceSchemaManagerException(
      `Cannot create "${schemaName}"."${tableName}": tsvector column(s) ${columnNamesMissingExpression.join(', ')} have no generated expression`,
      WorkspaceSchemaManagerExceptionCode.MISSING_GENERATED_COLUMN_EXPRESSION,
    );
  }
};

const buildCreateTableSql = ({
  schemaName,
  tableName,
  columnDefinitions = [],
}: {
  schemaName: string;
  tableName: string;
  columnDefinitions?: WorkspaceSchemaColumnDefinition[];
}): string => {
  assertTsVectorColumnsHaveExpression({
    schemaName,
    tableName,
    columnDefinitions,
  });

  const sqlColumnDefinitions = columnDefinitions.map((columnDefinition) =>
    buildSqlColumnDefinition(columnDefinition),
  );

  if (sqlColumnDefinitions.length === 0) {
    sqlColumnDefinitions.push(
      '"id" uuid PRIMARY KEY DEFAULT gen_random_uuid()',
    );
  }

  return `CREATE TABLE IF NOT EXISTS ${escapeIdentifier(schemaName)}.${escapeIdentifier(tableName)} (${sqlColumnDefinitions.join(', ')})`;
};

export class WorkspaceSchemaTableManagerService {
  async createTable({
    queryRunner,
    schemaName,
    tableName,
    columnDefinitions,
  }: {
    queryRunner: QueryRunner;
    schemaName: string;
    tableName: string;
    columnDefinitions?: WorkspaceSchemaColumnDefinition[];
  }): Promise<void> {
    await queryRunner.query(
      buildCreateTableSql({ schemaName, tableName, columnDefinitions }),
    );
  }

  async createTables({
    queryRunner,
    schemaName,
    tables,
  }: {
    queryRunner: QueryRunner;
    schemaName: string;
    tables: {
      tableName: string;
      columnDefinitions?: WorkspaceSchemaColumnDefinition[];
    }[];
  }): Promise<void> {
    if (tables.length === 0) {
      return;
    }

    const sql = tables
      .map(({ tableName, columnDefinitions }) =>
        buildCreateTableSql({ schemaName, tableName, columnDefinitions }),
      )
      .join(';\n');

    await queryRunner.query(sql);
  }

  async dropTable({
    queryRunner,
    schemaName,
    tableName,
    cascade = false,
  }: {
    queryRunner: QueryRunner;
    schemaName: string;
    tableName: string;
    cascade?: boolean;
  }): Promise<void> {
    const cascadeClause = cascade ? ' CASCADE' : '';
    const sql = `DROP TABLE IF EXISTS ${escapeIdentifier(schemaName)}.${escapeIdentifier(tableName)}${cascadeClause}`;

    await queryRunner.query(sql);
  }

  async renameTable({
    queryRunner,
    schemaName,
    oldTableName,
    newTableName,
  }: {
    queryRunner: QueryRunner;
    schemaName: string;
    oldTableName: string;
    newTableName: string;
  }): Promise<void> {
    const sql = `ALTER TABLE ${escapeIdentifier(schemaName)}.${escapeIdentifier(oldTableName)} RENAME TO ${escapeIdentifier(newTableName)}`;

    await queryRunner.query(sql);
  }
}
