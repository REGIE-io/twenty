import { STANDARD_OBJECTS } from 'twenty-shared/metadata';
import { DataSource } from 'typeorm';
import { v4 as uuid } from 'uuid';

import { AddPersonAdditionalEmailsGinIndexCommand } from 'src/database/commands/upgrade-version-command/2-32/2-32-workspace-command-1791417600000-add-person-additional-emails-gin-index.command';
import { WorkspaceSchemaIndexManagerService } from 'src/engine/twenty-orm/workspace-schema-manager/services/workspace-schema-index-manager.service';
import { getWorkspaceSchemaName } from 'src/engine/workspace-datasource/utils/get-workspace-schema-name.util';
import { computeTwentyStandardApplicationAllFlatEntityMaps } from 'src/engine/workspace-manager/twenty-standard-application/utils/twenty-standard-application-all-flat-entity-maps.constant';

const INDEX_UNIVERSAL_IDENTIFIER =
  STANDARD_OBJECTS.person.indexes.emailsAdditionalEmailsGinIndex
    .universalIdentifier;
const workspaceId = uuid();
const schemaName = getWorkspaceSchemaName(workspaceId);
const twentyStandardApplicationId = uuid();
const maps = computeTwentyStandardApplicationAllFlatEntityMaps({
  workspaceId,
  now: new Date().toISOString(),
  twentyStandardApplicationId,
}).allFlatEntityMaps;
const indexName =
  maps.flatIndexMaps.byUniversalIdentifier[INDEX_UNIVERSAL_IDENTIFIER]!.name;
const mapsWithoutIndex = {
  ...maps,
  flatIndexMaps: {
    ...maps.flatIndexMaps,
    byUniversalIdentifier: {
      ...maps.flatIndexMaps.byUniversalIdentifier,
      [INDEX_UNIVERSAL_IDENTIFIER]: undefined,
    },
  },
};

const buildCommand = ({
  cachedMaps = mapsWithoutIndex,
  dataSource = { createQueryRunner: jest.fn() } as never,
  migrationStatus = 'success',
}: {
  cachedMaps?: unknown;
  dataSource?: DataSource;
  migrationStatus?: 'success' | 'fail';
} = {}) => {
  const migrationService = {
    validateBuildAndRunWorkspaceMigration: jest
      .fn()
      .mockResolvedValue({ status: migrationStatus }),
  };
  const command = new AddPersonAdditionalEmailsGinIndexCommand(
    {} as never,
    {
      findWorkspaceTwentyStandardAndCustomApplicationOrThrow: async () => ({
        twentyStandardFlatApplication: {
          id: twentyStandardApplicationId,
          universalIdentifier: 'twenty-standard',
        },
      }),
    } as never,
    { getOrRecompute: async () => cachedMaps } as never,
    { indexManager: new WorkspaceSchemaIndexManagerService() } as never,
    migrationService as never,
    dataSource,
  );
  const run = (dryRun = false) =>
    command.runOnWorkspace({ workspaceId, index: 0, total: 1, options: { dryRun } });

  return { run, migrationService, dataSource };
};

it('skips workspaces without a person object or with the index already registered', async () => {
  for (const cachedMaps of [
    { ...mapsWithoutIndex, flatObjectMetadataMaps: { byUniversalIdentifier: {} } },
    maps,
  ]) {
    const { run, migrationService, dataSource } = buildCommand({ cachedMaps });

    await run();
    expect(dataSource.createQueryRunner).not.toHaveBeenCalled();
    expect(
      migrationService.validateBuildAndRunWorkspaceMigration,
    ).not.toHaveBeenCalled();
  }
});

it('dry-run changes neither the schema nor the metadata', async () => {
  const { run, migrationService, dataSource } = buildCommand();

  await run(true);
  expect(dataSource.createQueryRunner).not.toHaveBeenCalled();
  expect(
    migrationService.validateBuildAndRunWorkspaceMigration,
  ).not.toHaveBeenCalled();
});

const integration = process.env.CRM_DUPLICATES_TEST_DATABASE_URL
  ? describe
  : describe.skip;

integration('person additional emails GIN index against PostgreSQL', () => {
  let dataSource: DataSource;
  const readIndex = () =>
    dataSource.query(
      `SELECT i.indisvalid AS "isValid", pg_get_indexdef(i.indexrelid) AS definition
       FROM pg_index i JOIN pg_class c ON c.oid = i.indexrelid
       JOIN pg_namespace n ON n.oid = c.relnamespace
       WHERE n.nspname = $1 AND c.relname = $2`,
      [schemaName, indexName],
    );
  const expectedIndex = {
    isValid: true,
    definition: `CREATE INDEX "${indexName}" ON ${schemaName}.person USING gin ("emailsAdditionalEmails")`,
  };

  beforeAll(async () => {
    jest.useRealTimers();
    dataSource = new DataSource({
      type: 'postgres',
      url: process.env.CRM_DUPLICATES_TEST_DATABASE_URL,
    });
    await dataSource.initialize();
  });
  beforeEach(async () => {
    await dataSource.query(`CREATE SCHEMA "${schemaName}"`);
    await dataSource.query(
      `CREATE TABLE "${schemaName}"."person" (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), "emailsPrimaryEmail" text, "emailsAdditionalEmails" jsonb)`,
    );
    await dataSource.query(
      `INSERT INTO "${schemaName}"."person" ("emailsAdditionalEmails") VALUES ('["a@example.test"]'), ('["b@example.test"]')`,
    );
  });
  afterEach(async () => {
    await dataSource.query(`DROP SCHEMA "${schemaName}" CASCADE`);
  });
  afterAll(async () => {
    await dataSource.destroy();
  });

  it('builds the GIN index concurrently, then persists the standard index metadata', async () => {
    const { run, migrationService } = buildCommand({ dataSource });

    await run();
    expect(await readIndex()).toEqual([expectedIndex]);
    expect(
      migrationService.validateBuildAndRunWorkspaceMigration,
    ).toHaveBeenCalledWith(
      expect.objectContaining({
        workspaceId,
        allFlatEntityOperationByMetadataName: {
          index: {
            flatEntityToCreate: [
              expect.objectContaining({
                universalIdentifier: INDEX_UNIVERSAL_IDENTIFIER,
                name: indexName,
              }),
            ],
            flatEntityToDelete: [],
            flatEntityToUpdate: [],
          },
        },
      }),
    );

    await run();
    expect(await readIndex()).toEqual([expectedIndex]);
  });

  it('replaces an invalid index left by an interrupted concurrent build', async () => {
    await expect(
      dataSource.query(
        `CREATE UNIQUE INDEX CONCURRENTLY "${indexName}" ON "${schemaName}"."person" ((1))`,
      ),
    ).rejects.toThrow();
    expect(await readIndex()).toEqual([
      expect.objectContaining({ isValid: false }),
    ]);

    await buildCommand({ dataSource }).run();
    expect(await readIndex()).toEqual([expectedIndex]);
  });

  it('fails when the index metadata cannot be persisted', async () => {
    await expect(
      buildCommand({ dataSource, migrationStatus: 'fail' }).run(),
    ).rejects.toThrow('Failed to persist person additional emails GIN index');
  });
});
