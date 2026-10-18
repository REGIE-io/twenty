import { createOneObjectMetadata } from 'test/integration/metadata/suites/object-metadata/utils/create-one-object-metadata.util';
import { getAppProviderByClassName } from 'test/integration/utils/get-app-provider-by-class-name.util';

import { type DropAgentTurnEvaluationObjectCommand } from 'src/database/commands/upgrade-version-command/2-46/2-46-workspace-command-1791216273979-drop-agent-turn-evaluation-object.command';
import { type WorkspaceCacheService } from 'src/engine/workspace-cache/services/workspace-cache.service';
import { getWorkspaceSchemaName } from 'src/engine/workspace-datasource/utils/get-workspace-schema-name.util';
import { SEED_APPLE_WORKSPACE_ID } from 'src/engine/workspace-manager/dev-seeder/core/constants/seeder-workspaces.constant';

const AGENT_TURN_EVALUATION_OBJECT_UNIVERSAL_IDENTIFIER =
  '73741409-7835-426f-8425-9de13af22302';

const RUN_ON_WORKSPACE_ARGS = {
  workspaceId: SEED_APPLE_WORKSPACE_ID,
  options: {},
  index: 0,
  total: 1,
};

describe('2-46 workspace command - drop agent turn evaluation object (integration)', () => {
  let command: DropAgentTurnEvaluationObjectCommand;
  let workspaceCacheService: WorkspaceCacheService;
  let objectMetadataId: string;
  let fixtureIndexNames: string[] = [];

  const cleanupFixtureRelations = async () => {
    // The custom stand-in creates inverse relations the retired standard object never had.
    const schema = getWorkspaceSchemaName(SEED_APPLE_WORKSPACE_ID);
    const columns: { table_name: string }[] = await global.testDataSource.query(
      `SELECT table_name FROM information_schema.columns
       WHERE table_schema = $1 AND column_name = 'targetLegacyTurnEvaluationId'`,
      [schema],
    );
    const tableNames = columns.map(({ table_name }) => table_name);
    const remainingFields = await global.testDataSource.query(
      `SELECT field.id FROM core."fieldMetadata" field
       JOIN core."objectMetadata" object ON object.id = field."objectMetadataId"
       WHERE object."workspaceId" = $1 AND object."nameSingular" = ANY($2)
         AND field.name = 'targetLegacyTurnEvaluation'`,
      [SEED_APPLE_WORKSPACE_ID, tableNames],
    );

    expect(remainingFields).toEqual([]);

    const indexes: { indexname: string }[] = await global.testDataSource.query(
      `SELECT indexname FROM pg_indexes WHERE schemaname = $1 AND tablename = ANY($2)
       AND indexdef LIKE '%("targetLegacyTurnEvaluationId")'`,
      [schema, tableNames],
    );
    const indexNames = [
      ...new Set([
        ...fixtureIndexNames,
        ...indexes.map(({ indexname }) => indexname),
      ]),
    ];

    await global.testDataSource.query(
      `DELETE FROM core."indexMetadata" indexMetadata
       WHERE "workspaceId" = $1 AND name = ANY($2)
         AND NOT EXISTS (SELECT 1 FROM core."indexFieldMetadata" indexField
                         WHERE indexField."indexMetadataId" = indexMetadata.id)`,
      [SEED_APPLE_WORKSPACE_ID, indexNames],
    );

    expect(
      await global.testDataSource.query(
        'SELECT id FROM core."indexMetadata" WHERE "workspaceId" = $1 AND name = ANY($2)',
        [SEED_APPLE_WORKSPACE_ID, indexNames],
      ),
    ).toEqual([]);

    for (const table of tableNames) {
      await global.testDataSource.query(
        `ALTER TABLE "${schema}".${global.testDataSource.driver.escape(table)} DROP COLUMN "targetLegacyTurnEvaluationId"`,
      );
    }

    expect(
      await global.testDataSource.query(
        `SELECT table_name FROM information_schema.columns
       WHERE table_schema = $1 AND column_name = 'targetLegacyTurnEvaluationId'`,
        [schema],
      ),
    ).toEqual([]);

    await workspaceCacheService.invalidateAndRecompute(
      SEED_APPLE_WORKSPACE_ID,
      ['flatObjectMetadataMaps', 'flatFieldMetadataMaps', 'flatIndexMaps'],
    );
  };

  const findEvaluationObject = async () => {
    const { flatObjectMetadataMaps } =
      await workspaceCacheService.getOrRecompute(SEED_APPLE_WORKSPACE_ID, [
        'flatObjectMetadataMaps',
      ]);

    return flatObjectMetadataMaps.byUniversalIdentifier[
      AGENT_TURN_EVALUATION_OBJECT_UNIVERSAL_IDENTIFIER
    ];
  };

  const countEvaluationTables = async () => {
    const [{ count }] = await global.testDataSource.query(
      `SELECT count(*) FROM information_schema.tables
       WHERE table_schema = $1 AND table_name ILIKE '%legacyTurnEvaluation%'`,
      [getWorkspaceSchemaName(SEED_APPLE_WORKSPACE_ID)],
    );

    return Number(count);
  };

  beforeAll(async () => {
    command = getAppProviderByClassName<DropAgentTurnEvaluationObjectCommand>(
      'DropAgentTurnEvaluationObjectCommand',
    );
    workspaceCacheService = getAppProviderByClassName<WorkspaceCacheService>(
      'WorkspaceCacheService',
    );

    await cleanupFixtureRelations();

    const { data } = await createOneObjectMetadata({
      expectToFail: false,
      input: {
        nameSingular: 'legacyTurnEvaluation',
        namePlural: 'legacyTurnEvaluations',
        labelSingular: 'Legacy turn evaluation',
        labelPlural: 'Legacy turn evaluations',
        icon: 'IconLego',
      },
    });

    objectMetadataId = data.createOneObject.id;

    const fixtureIndexes: { name: string }[] =
      await global.testDataSource.query(
        `SELECT DISTINCT indexMetadata.name FROM core."indexMetadata" indexMetadata
       JOIN core."indexFieldMetadata" indexField ON indexField."indexMetadataId" = indexMetadata.id
       JOIN core."fieldMetadata" field ON field.id = indexField."fieldMetadataId"
       WHERE field."workspaceId" = $1 AND field."relationTargetObjectMetadataId" = $2`,
        [SEED_APPLE_WORKSPACE_ID, objectMetadataId],
      );

    fixtureIndexNames = fixtureIndexes.map(({ name }) => name);

    // Stands in for the object a workspace provisioned before 2.46
    await global.testDataSource.query(
      `UPDATE core."objectMetadata" SET "universalIdentifier" = $1 WHERE id = $2`,
      [AGENT_TURN_EVALUATION_OBJECT_UNIVERSAL_IDENTIFIER, objectMetadataId],
    );
    await workspaceCacheService.invalidateAndRecompute(
      SEED_APPLE_WORKSPACE_ID,
      ['flatObjectMetadataMaps', 'flatFieldMetadataMaps', 'flatIndexMaps'],
    );
  });

  afterAll(async () => {
    try {
      if (objectMetadataId) {
        await command.runOnWorkspace(RUN_ON_WORKSPACE_ARGS);
        expect(await findEvaluationObject()).toBeUndefined();
        expect(await countEvaluationTables()).toBe(0);
      }
    } finally {
      await cleanupFixtureRelations();
    }
  });

  it('deletes the object and its table', async () => {
    expect(await findEvaluationObject()).toBeDefined();
    expect(await countEvaluationTables()).toBe(1);

    await command.runOnWorkspace(RUN_ON_WORKSPACE_ARGS);

    expect(await findEvaluationObject()).toBeUndefined();
    expect(await countEvaluationTables()).toBe(0);
    expect(
      await global.testDataSource.query(
        `SELECT id FROM core."objectMetadata" WHERE id = $1`,
        [objectMetadataId],
      ),
    ).toEqual([]);
  });

  it('changes nothing when it runs again', async () => {
    await expect(
      command.runOnWorkspace(RUN_ON_WORKSPACE_ARGS),
    ).resolves.toBeUndefined();
    expect(await findEvaluationObject()).toBeUndefined();
  });
});
