import { FieldMetadataType } from 'twenty-shared/types';
import { isDefined } from 'twenty-shared/utils';
import { DataSource, type QueryRunner } from 'typeorm';
import { v4 as uuid } from 'uuid';

import { isMorphOrRelationFlatFieldMetadata } from 'src/engine/metadata-modules/flat-field-metadata/utils/is-morph-or-relation-flat-field-metadata.util';
import { WorkspaceSchemaColumnManagerService } from 'src/engine/twenty-orm/workspace-schema-manager/services/workspace-schema-column-manager.service';
import { WorkspaceSchemaEnumManagerService } from 'src/engine/twenty-orm/workspace-schema-manager/services/workspace-schema-enum-manager.service';
import { WorkspaceSchemaForeignKeyManagerService } from 'src/engine/twenty-orm/workspace-schema-manager/services/workspace-schema-foreign-key-manager.service';
import { WorkspaceSchemaIndexManagerService } from 'src/engine/twenty-orm/workspace-schema-manager/services/workspace-schema-index-manager.service';
import { WorkspaceSchemaTableManagerService } from 'src/engine/twenty-orm/workspace-schema-manager/services/workspace-schema-table-manager.service';
import { WorkspaceSchemaManagerService } from 'src/engine/twenty-orm/workspace-schema-manager/workspace-schema-manager.service';
import { getWorkspaceSchemaName } from 'src/engine/workspace-datasource/utils/get-workspace-schema-name.util';
import { computeTwentyStandardApplicationAllFlatEntityMaps } from 'src/engine/workspace-manager/twenty-standard-application/utils/twenty-standard-application-all-flat-entity-maps.constant';
import { type FlatCreateObjectAction } from 'src/engine/workspace-manager/workspace-migration/workspace-migration-builder/builders/object/types/workspace-migration-object-action';
import { CreateObjectActionHandlerService } from 'src/engine/workspace-manager/workspace-migration/workspace-migration-runner/action-handlers/object/services/create-object-action-handler.service';
import { type WorkspaceMigrationActionRunnerContext } from 'src/engine/workspace-manager/workspace-migration/workspace-migration-runner/types/workspace-migration-action-runner-args.type';

type Recorder = {
  queryRunner: QueryRunner;
  statements: string[];
  queryCallCount: () => number;
  insertedRowsByEntity: Map<string, Record<string, unknown>[]>;
};

const buildRecorder = (): Recorder => {
  const statements: string[] = [];
  const insertedRowsByEntity = new Map<string, Record<string, unknown>[]>();
  let calls = 0;

  const queryRunner = {
    isTransactionActive: true,
    query: async (sql: string) => {
      calls += 1;
      statements.push(...sql.split(';\n'));

      return [];
    },
    manager: {
      getRepository: (entity: { name: string }) => ({
        insert: async (rows: Record<string, unknown>[]) => {
          insertedRowsByEntity.set(entity.name, [
            ...(insertedRowsByEntity.get(entity.name) ?? []),
            ...rows,
          ]);
        },
      }),
    },
  } as unknown as QueryRunner;

  return {
    queryRunner,
    statements,
    queryCallCount: () => calls,
    insertedRowsByEntity,
  };
};

const buildHandler = () =>
  new CreateObjectActionHandlerService(
    new WorkspaceSchemaManagerService(
      new WorkspaceSchemaTableManagerService(),
      new WorkspaceSchemaColumnManagerService(),
      new WorkspaceSchemaIndexManagerService(),
      new WorkspaceSchemaEnumManagerService(),
      new WorkspaceSchemaForeignKeyManagerService(),
    ),
  );

// Mirrors aggregateNonRelationFieldsIntoObjectActions: a create-object action carries the
// object's scalar fields, relations are created afterwards as separate field actions.
const buildStandardCreateObjectContexts = (workspaceId: string) => {
  const { allFlatEntityMaps } =
    computeTwentyStandardApplicationAllFlatEntityMaps({
      workspaceId,
      now: new Date('2026-01-01T00:00:00.000Z').toISOString(),
      twentyStandardApplicationId: uuid(),
    });

  const flatObjectMetadatas = Object.values(
    allFlatEntityMaps.flatObjectMetadataMaps.byUniversalIdentifier,
  ).filter(isDefined);
  const flatFieldMetadatas = Object.values(
    allFlatEntityMaps.flatFieldMetadataMaps.byUniversalIdentifier,
  ).filter(isDefined);

  return (queryRunner: QueryRunner) =>
    flatObjectMetadatas.map(
      (flatObjectMetadata) =>
        ({
          queryRunner,
          workspaceId,
          allFlatEntityMaps,
          flatAction: {
            type: 'create',
            metadataName: 'objectMetadata',
            flatEntity: flatObjectMetadata,
            flatFieldMetadatas: flatFieldMetadatas.filter(
              (flatFieldMetadata) =>
                flatFieldMetadata.objectMetadataId === flatObjectMetadata.id &&
                !isMorphOrRelationFlatFieldMetadata(flatFieldMetadata),
            ),
          },
        }) as unknown as WorkspaceMigrationActionRunnerContext<FlatCreateObjectAction>,
    );
};

const runOneAtATime = async (
  handler: CreateObjectActionHandlerService,
  contexts: WorkspaceMigrationActionRunnerContext<FlatCreateObjectAction>[],
) => {
  for (const context of contexts) {
    await handler.executeForMetadata(context);
    await handler.executeForWorkspaceSchema(context);
  }
};

const runBatched = async (
  handler: CreateObjectActionHandlerService,
  contexts: WorkspaceMigrationActionRunnerContext<FlatCreateObjectAction>[],
) => {
  await handler.executeForMetadataBatch(contexts);
  await handler.executeForWorkspaceSchemaBatch(contexts);
};

const sortRowsById = (rows: Record<string, unknown>[] = []) =>
  [...rows].sort((a, b) => String(a.id).localeCompare(String(b.id)));

const createTableStatementFor = (statements: string[], tableName: string) =>
  statements.find(
    (statement) =>
      statement.startsWith(`CREATE TABLE IF NOT EXISTS`) &&
      statement.includes(`."${tableName}" (`),
  );

describe('CreateObjectActionHandlerService on the full Twenty standard application', () => {
  const workspaceId = uuid();
  const buildContexts = buildStandardCreateObjectContexts(workspaceId);

  const runBoth = async () => {
    const oneAtATime = buildRecorder();
    const batched = buildRecorder();

    await runOneAtATime(buildHandler(), buildContexts(oneAtATime.queryRunner));
    await runBatched(buildHandler(), buildContexts(batched.queryRunner));

    return { oneAtATime, batched };
  };

  it('covers every standard object, including the ones with a searchVector', () => {
    const contexts = buildContexts(buildRecorder().queryRunner);
    const withSearchVector = contexts.filter((context) =>
      context.flatAction.flatFieldMetadatas.some(
        (field) => field.type === FieldMetadataType.TS_VECTOR,
      ),
    );

    expect(contexts).toHaveLength(28);
    expect(withSearchVector.length).toBeGreaterThan(0);
  });

  it('opts object creation into batching', () => {
    expect(buildHandler().canBatchCreate).toBe(true);
  });

  it('issues exactly the same DDL batched as one object at a time', async () => {
    const { oneAtATime, batched } = await runBoth();

    expect([...batched.statements].sort()).toEqual(
      [...oneAtATime.statements].sort(),
    );
  });

  it('gives every searchVector column its generated expression when batched', async () => {
    const { batched } = await runBoth();
    const contexts = buildContexts(buildRecorder().queryRunner);

    for (const context of contexts) {
      const tsVectorFields = context.flatAction.flatFieldMetadatas.filter(
        (field) => field.type === FieldMetadataType.TS_VECTOR,
      );
      const statement = createTableStatementFor(
        batched.statements,
        context.flatAction.flatEntity.nameSingular,
      );

      expect(statement).toBeDefined();

      for (const tsVectorField of tsVectorFields) {
        expect(statement).toMatch(
          new RegExp(
            `"${tsVectorField.name}" tsvector GENERATED ALWAYS AS \\([\\s\\S]+\\) STORED`,
          ),
        );
      }
    }
  });

  it('creates every enum type before the table that uses it when batched', async () => {
    const { batched } = await runBoth();
    const firstCreateTableIndex = batched.statements.findIndex((statement) =>
      statement.startsWith('CREATE TABLE'),
    );
    const lastCreateTypeIndex = batched.statements.reduce(
      (last, statement, index) =>
        statement.startsWith('CREATE TYPE') ? index : last,
      -1,
    );

    expect(lastCreateTypeIndex).toBeGreaterThan(-1);
    expect(lastCreateTypeIndex).toBeLessThan(firstCreateTableIndex);
  });

  it('creates all tables in one round trip', async () => {
    const { oneAtATime, batched } = await runBoth();
    const objectCount = buildContexts(buildRecorder().queryRunner).length;

    expect(batched.queryCallCount()).toBe(
      oneAtATime.queryCallCount() - (objectCount - 1),
    );
  });

  it('inserts the same object and field metadata rows batched as one object at a time', async () => {
    const { oneAtATime, batched } = await runBoth();

    expect([...batched.insertedRowsByEntity.keys()].sort()).toEqual(
      [...oneAtATime.insertedRowsByEntity.keys()].sort(),
    );

    for (const [entityName, rows] of oneAtATime.insertedRowsByEntity) {
      expect(
        sortRowsById(batched.insertedRowsByEntity.get(entityName)),
      ).toEqual(sortRowsById(rows));
    }
  });
});

const integration = process.env.WORKSPACE_SCHEMA_TEST_DATABASE_URL
  ? describe
  : describe.skip;

integration('CreateObjectActionHandlerService against PostgreSQL', () => {
  let dataSource: DataSource;
  const oneAtATimeWorkspaceId = uuid();
  const batchedWorkspaceId = uuid();
  const workspaceIds = [oneAtATimeWorkspaceId, batchedWorkspaceId];

  const createSchema = async (
    workspaceId: string,
    run: (
      handler: CreateObjectActionHandlerService,
      contexts: WorkspaceMigrationActionRunnerContext<FlatCreateObjectAction>[],
    ) => Promise<void>,
  ) => {
    const queryRunner = dataSource.createQueryRunner();

    await queryRunner.connect();
    await queryRunner.startTransaction();
    await queryRunner.query(
      `CREATE SCHEMA "${getWorkspaceSchemaName(workspaceId)}"`,
    );
    await run(
      buildHandler(),
      buildStandardCreateObjectContexts(workspaceId)(queryRunner),
    );
    await queryRunner.commitTransaction();
    await queryRunner.release();
  };

  const readCatalog = async (workspaceId: string) => {
    const schemaName = getWorkspaceSchemaName(workspaceId);
    const anonymize = (rows: Record<string, unknown>[]) =>
      JSON.parse(JSON.stringify(rows).split(schemaName).join('<schema>'));

    return {
      columns: anonymize(
        await dataSource.query(
          `SELECT table_name, column_name, ordinal_position, data_type, udt_name, is_nullable,
                  column_default, is_generated, generation_expression
           FROM information_schema.columns WHERE table_schema = $1
           ORDER BY table_name, ordinal_position`,
          [schemaName],
        ),
      ),
      enums: anonymize(
        await dataSource.query(
          `SELECT t.typname, array_agg(e.enumlabel ORDER BY e.enumsortorder) AS labels
           FROM pg_type t JOIN pg_enum e ON e.enumtypid = t.oid
           JOIN pg_namespace n ON n.oid = t.typnamespace
           WHERE n.nspname = $1 GROUP BY t.typname ORDER BY t.typname`,
          [schemaName],
        ),
      ),
      indexes: anonymize(
        await dataSource.query(
          `SELECT tablename, indexname, indexdef FROM pg_indexes
           WHERE schemaname = $1 ORDER BY tablename, indexname`,
          [schemaName],
        ),
      ),
      constraints: anonymize(
        await dataSource.query(
          `SELECT c.relname, con.conname, pg_get_constraintdef(con.oid) AS definition
           FROM pg_constraint con JOIN pg_class c ON c.oid = con.conrelid
           JOIN pg_namespace n ON n.oid = con.connamespace
           WHERE n.nspname = $1 ORDER BY c.relname, con.conname`,
          [schemaName],
        ),
      ),
    };
  };

  const insertSearchablePerson = async (workspaceId: string) => {
    const [row] = await dataSource.query(
      `INSERT INTO "${getWorkspaceSchemaName(workspaceId)}"."person"
         ("nameFirstName", "nameLastName", "emailsPrimaryEmail", "jobTitle")
       VALUES ('Zoë', 'Lovelace', 'zoe@example.com', 'Engineer')
       RETURNING "searchVector"::text AS "searchVector"`,
    );

    return row.searchVector as string | null;
  };

  beforeAll(async () => {
    jest.useRealTimers();
    dataSource = new DataSource({
      type: 'postgres',
      url: process.env.WORKSPACE_SCHEMA_TEST_DATABASE_URL,
    });
    await dataSource.initialize();
    await dataSource.query('CREATE EXTENSION IF NOT EXISTS "uuid-ossp"');
    await dataSource.query('CREATE EXTENSION IF NOT EXISTS "unaccent"');
    await dataSource.query(`CREATE OR REPLACE FUNCTION public.unaccent_immutable(input text)
      RETURNS text LANGUAGE sql IMMUTABLE
      AS $$ SELECT public.unaccent('public.unaccent'::regdictionary, input) $$`);

    await createSchema(oneAtATimeWorkspaceId, async (handler, contexts) => {
      for (const context of contexts) {
        await handler.executeForWorkspaceSchema(context);
      }
    });
    await createSchema(batchedWorkspaceId, (handler, contexts) =>
      handler.executeForWorkspaceSchemaBatch(contexts),
    );
  });

  afterAll(async () => {
    for (const workspaceId of workspaceIds) {
      await dataSource.query(
        `DROP SCHEMA IF EXISTS "${getWorkspaceSchemaName(workspaceId)}" CASCADE`,
      );
    }
    await dataSource.destroy();
  });

  it('builds a catalog identical to the one-at-a-time path', async () => {
    const oneAtATime = await readCatalog(oneAtATimeWorkspaceId);

    expect(oneAtATime.columns.length).toBeGreaterThan(0);
    expect(await readCatalog(batchedWorkspaceId)).toEqual(oneAtATime);
  });

  it('generates every searchVector column from its expression', async () => {
    const { columns } = await readCatalog(batchedWorkspaceId);
    const tsVectorColumns = columns.filter(
      (column: { udt_name: string }) => column.udt_name === 'tsvector',
    );

    expect(tsVectorColumns.length).toBeGreaterThan(0);

    for (const column of tsVectorColumns) {
      expect(column.is_generated).toBe('ALWAYS');
      expect(column.generation_expression).toContain('to_tsvector');
    }
  });

  it('populates searchVector on insert, identically on both paths', async () => {
    const oneAtATime = await insertSearchablePerson(oneAtATimeWorkspaceId);
    const batched = await insertSearchablePerson(batchedWorkspaceId);

    expect(batched).toContain("'zoe'");
    expect(batched).toContain("'lovelace'");
    expect(batched).toEqual(oneAtATime);
  });
});
