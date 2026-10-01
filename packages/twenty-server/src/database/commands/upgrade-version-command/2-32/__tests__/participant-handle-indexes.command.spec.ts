import { STANDARD_OBJECTS } from 'twenty-shared/metadata';
import { isDefined } from 'twenty-shared/utils';
import { DataSource } from 'typeorm';
import { v4 as uuid } from 'uuid';

import { AddParticipantHandleIndexesCommand } from 'src/database/commands/upgrade-version-command/2-32/2-32-workspace-command-1790812800000-add-participant-handle-indexes.command';
import { WorkspaceSchemaTableManagerService } from 'src/engine/twenty-orm/workspace-schema-manager/services/workspace-schema-table-manager.service';
import { getWorkspaceSchemaName } from 'src/engine/workspace-datasource/utils/get-workspace-schema-name.util';
import { computeTwentyStandardApplicationAllFlatEntityMaps } from 'src/engine/workspace-manager/twenty-standard-application/utils/twenty-standard-application-all-flat-entity-maps.constant';
import { CreateObjectActionHandlerService } from 'src/engine/workspace-manager/workspace-migration/workspace-migration-runner/action-handlers/object/services/create-object-action-handler.service';
import {
  ensureParticipantHandleIndex,
  PARTICIPANT_HANDLE_INDEXES,
} from 'src/engine/workspace-manager/workspace-migration/workspace-migration-runner/action-handlers/object/utils/ensure-participant-handle-index.util';

const workspaceId = uuid();
const schemaName = getWorkspaceSchemaName(workspaceId);
const maps = computeTwentyStandardApplicationAllFlatEntityMaps({
  workspaceId,
  now: new Date().toISOString(),
  twentyStandardApplicationId: uuid(),
}).allFlatEntityMaps;
const objects = PARTICIPANT_HANDLE_INDEXES.map(
  ({ universalIdentifier }) => maps.flatObjectMetadataMaps.byUniversalIdentifier[universalIdentifier]!,
);

it('ignores unrelated and custom objects without database access', async () => {
  const queryRunner = { query: jest.fn() };

  for (const objectMetadata of [
    maps.flatObjectMetadataMaps.byUniversalIdentifier[STANDARD_OBJECTS.person.universalIdentifier]!,
    { ...objects[0], isCustom: true },
  ]) {
    await ensureParticipantHandleIndex({ queryRunner: queryRunner as never, workspaceId, objectMetadata });
  }
  expect(queryRunner.query).not.toHaveBeenCalled();
});

it('skips workspaces whose participant objects have not been provisioned', async () => {
  const dataSource = { createQueryRunner: jest.fn() };
  const command = new AddParticipantHandleIndexesCommand(
    {} as never,
    { getOrRecompute: async () => ({ flatObjectMetadataMaps: { byUniversalIdentifier: {} } }) } as never,
    dataSource as never,
  );

  await command.runOnWorkspace({ workspaceId, index: 0, total: 1, options: {} });
  expect(dataSource.createQueryRunner).not.toHaveBeenCalled();
});

const integration = process.env.CRM_DUPLICATES_TEST_DATABASE_URL ? describe : describe.skip;

integration('participant handle indexes against PostgreSQL', () => {
  let dataSource: DataSource;
  const command = () => new AddParticipantHandleIndexesCommand(
    {} as never,
    { getOrRecompute: async () => maps } as never,
    dataSource,
  );
  const run = (dryRun = false) => command().runOnWorkspace({ workspaceId, index: 0, total: 1, options: { dryRun } });
  const readIndexes = () => dataSource.query(
    `SELECT c.relname AS name, i.indisunique AS "isUnique", i.indisvalid AS "isValid",
            pg_get_expr(i.indexprs, i.indrelid) AS expression
     FROM pg_index i JOIN pg_class c ON c.oid=i.indexrelid
     JOIN pg_namespace n ON n.oid=c.relnamespace
     WHERE n.nspname=$1 AND c.relname=ANY($2) ORDER BY c.relname`,
    [schemaName, PARTICIPANT_HANDLE_INDEXES.map(({ indexName }) => indexName)],
  );

  beforeAll(async () => {
    jest.useRealTimers();
    dataSource = new DataSource({ type: 'postgres', url: process.env.CRM_DUPLICATES_TEST_DATABASE_URL });
    await dataSource.initialize();
    await dataSource.query('CREATE EXTENSION IF NOT EXISTS "uuid-ossp" WITH SCHEMA public');
  });
  beforeEach(async () => {
    await dataSource.query(`CREATE SCHEMA "${schemaName}"`);
    for (const object of objects) {
      await dataSource.query(`CREATE TABLE "${schemaName}"."${object.nameSingular}" (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), handle text, "personId" uuid, "deletedAt" timestamptz)`);
      await dataSource.query(`CREATE INDEX ON "${schemaName}"."${object.nameSingular}" ("personId")`);
    }
  });
  afterEach(async () => {
    await dataSource.query(`DROP SCHEMA "${schemaName}" CASCADE`);
  });
  afterAll(async () => { await dataSource.destroy(); });

  it('dry-run leaves indexes unchanged; upgrade and rerun are non-unique and stable', async () => {
    await run(true);
    expect(await readIndexes()).toEqual([]);
    await run();
    const first = await readIndexes();

    expect(first).toHaveLength(2);
    expect(first).toEqual(expect.arrayContaining(PARTICIPANT_HANDLE_INDEXES.map(({ indexName }) => ({
      name: indexName, isUnique: false, isValid: true, expression: 'lower(TRIM(BOTH FROM handle))',
    }))));
    await run();
    expect(await readIndexes()).toEqual(first);
    for (const object of objects) {
      await dataSource.query(`INSERT INTO "${schemaName}"."${object.nameSingular}" (handle) VALUES (' Shared@Example.test '), ('shared@example.test'), (NULL)`);
      const rows = await dataSource.query(`SELECT id FROM "${schemaName}"."${object.nameSingular}" WHERE LOWER(TRIM(handle))='shared@example.test'`);

      expect(rows).toHaveLength(2);
    }
  });

  it('rolls back the first index if the second table has a conflicting index', async () => {
    const target = PARTICIPANT_HANDLE_INDEXES[1];

    await dataSource.query(`CREATE INDEX "${target.indexName}" ON "${schemaName}"."${objects[1].nameSingular}" (handle)`);
    await expect(run()).rejects.toThrow('Conflicting participant handle index');
    expect(await readIndexes()).toHaveLength(1);
  });

  it('creates the same indexes through the new standard-object provisioning path', async () => {
    const handler = new CreateObjectActionHandlerService({ tableManager: new WorkspaceSchemaTableManagerService() } as never);
    const queryRunner = dataSource.createQueryRunner();

    await queryRunner.connect();
    try {
      for (const object of objects) {
        await queryRunner.query(`DROP TABLE "${schemaName}"."${object.nameSingular}"`);
        const flatFieldMetadatas = Object.values(maps.flatFieldMetadataMaps.byUniversalIdentifier)
          .filter(isDefined)
          .filter((field) => field.objectMetadataId === object.id && ['id', 'handle', 'deletedAt'].includes(field.name));

        await handler.executeForWorkspaceSchema({
          queryRunner,
          workspaceId,
          allFlatEntityMaps: maps,
          flatAction: { type: 'create', metadataName: 'objectMetadata', flatEntity: object, flatFieldMetadatas },
        } as never);
      }
      expect(await readIndexes()).toHaveLength(2);
      await run();
      expect(await readIndexes()).toHaveLength(2);
    } finally {
      await queryRunner.release();
    }
  });

  it('uses both lookup indexes for the OR predicate with selective address matches', async () => {
    await run();
    const personId = uuid();

    for (const object of objects) {
      const table = `"${schemaName}"."${object.nameSingular}"`;

      await dataSource.query(`INSERT INTO ${table} (handle) SELECT 'other-' || n || '@example.test' FROM generate_series(1, 20000) n`);
      await dataSource.query(`INSERT INTO ${table} (handle, "personId") VALUES ('direct@example.test', $1), (' Shared@Example.test ', NULL), ('shared@example.test', NULL)`, [personId]);
      await dataSource.query(`ANALYZE ${table}`);
      const predicate = `"personId"=ANY($1::uuid[]) OR LOWER(TRIM(handle))=ANY($2::text[])`;
      const rows = await dataSource.query(`SELECT id FROM ${table} WHERE ${predicate}`, [[personId], ['shared@example.test']]);
      const plan = await dataSource.query(`EXPLAIN (FORMAT JSON) SELECT id FROM ${table} WHERE ${predicate}`, [[personId], ['shared@example.test']]);

      expect(rows).toHaveLength(3);
      expect(JSON.stringify(plan)).toContain('BitmapOr');
      expect(JSON.stringify(plan)).toContain('NORMALIZED_HANDLE');
      expect(JSON.stringify(plan)).not.toContain('Seq Scan');
    }
  });
});
