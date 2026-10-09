import { DataSource, QueryRunner } from 'typeorm';

import { RegisteredInstanceCommand } from 'src/engine/core-modules/upgrade/decorators/registered-instance-command.decorator';
import { SlowInstanceCommand } from 'src/engine/core-modules/upgrade/interfaces/slow-instance-command.interface';

const FOREIGN_KEY_INDEXES = [
  {
    name: 'IDX_SEARCH_FIELD_METADATA_FIELD_METADATA_ID',
    table: 'searchFieldMetadata',
    column: 'fieldMetadataId',
  },
  {
    name: 'IDX_SEARCH_FIELD_METADATA_TS_VECTOR_FIELD_METADATA_ID',
    table: 'searchFieldMetadata',
    column: 'tsVectorFieldMetadataId',
  },
  {
    name: 'IDX_INDEX_FIELD_METADATA_INDEX_METADATA_ID',
    table: 'indexFieldMetadata',
    column: 'indexMetadataId',
  },
  {
    name: 'IDX_FIELD_METADATA_APPLICATION_ID',
    table: 'fieldMetadata',
    column: 'applicationId',
  },
] as const;

const indexDefinition = (index: (typeof FOREIGN_KEY_INDEXES)[number]) =>
  `"${index.name}" ON "core"."${index.table}" ("${index.column}")`;

@RegisteredInstanceCommand('2.32.0', 1791540000000, { type: 'slow' })
export class AddMetadataDeleteForeignKeyIndexesSlowInstanceCommand
  implements SlowInstanceCommand
{
  async runDataMigration(dataSource: DataSource): Promise<void> {
    for (const index of FOREIGN_KEY_INDEXES) {
      const invalid = await dataSource.query(
        `SELECT 1 FROM pg_index i JOIN pg_class c ON c.oid = i.indexrelid
        WHERE c.relname = $1 AND c.relnamespace = 'core'::regnamespace AND NOT i.indisvalid`,
        [index.name],
      );

      if (invalid.length > 0) {
        await dataSource.query(
          `DROP INDEX CONCURRENTLY IF EXISTS "core"."${index.name}"`,
        );
      }

      await dataSource.query(
        `CREATE INDEX CONCURRENTLY IF NOT EXISTS ${indexDefinition(index)}`,
      );
    }
  }

  public async up(queryRunner: QueryRunner): Promise<void> {
    for (const index of FOREIGN_KEY_INDEXES) {
      await queryRunner.query(
        `CREATE INDEX IF NOT EXISTS ${indexDefinition(index)}`,
      );
    }
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    for (const index of FOREIGN_KEY_INDEXES) {
      await queryRunner.query(`DROP INDEX IF EXISTS "core"."${index.name}"`);
    }
  }
}
