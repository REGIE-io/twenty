import { v4 as uuid } from 'uuid';
import { DataSource, EntitySchema } from 'typeorm';
import { STANDARD_OBJECTS } from 'twenty-shared/metadata';
import { isDefined } from 'twenty-shared/utils';

import { AllowDuplicateCrmIdentitiesCommand } from 'src/database/commands/upgrade-version-command/2-20/2-20-workspace-command-1790294400000-allow-duplicate-crm-identities.command';
import { FieldMetadataEntity } from 'src/engine/metadata-modules/field-metadata/field-metadata.entity';
import { IndexMetadataEntity } from 'src/engine/metadata-modules/index-metadata/index-metadata.entity';
import { WorkspaceSchemaIndexManagerService } from 'src/engine/twenty-orm/workspace-schema-manager/services/workspace-schema-index-manager.service';
import { getWorkspaceSchemaName } from 'src/engine/workspace-datasource/utils/get-workspace-schema-name.util';
import { computeTwentyStandardApplicationAllFlatEntityMaps } from 'src/engine/workspace-manager/twenty-standard-application/utils/twenty-standard-application-all-flat-entity-maps.constant';
import { getConflictingFields } from 'src/engine/api/common/common-query-runners/common-create-many-query-runner/utils/get-conflicting-fields.util';

const workspaceId = uuid();
const schema = getWorkspaceSchemaName(workspaceId);
const buildMaps = () => computeTwentyStandardApplicationAllFlatEntityMaps({ workspaceId, now: new Date().toISOString(), twentyStandardApplicationId: '20202020-0000-4000-8000-000000000001' }).allFlatEntityMaps;
const targets = [STANDARD_OBJECTS.person.fields.emails.universalIdentifier, STANDARD_OBJECTS.company.fields.domainName.universalIdentifier];

test('new workspaces keep lookup indexes but do not use shared email/domain as upsert identity', () => {
  const maps = buildMaps();
  for (const uid of targets) {
    const field = maps.flatFieldMetadataMaps.byUniversalIdentifier[uid]!;
    const object = maps.flatObjectMetadataMaps.byUniversalIdentifier[field.objectMetadataUniversalIdentifier]!;
    const indexes = Object.values(maps.flatIndexMaps.byUniversalIdentifier).filter(isDefined).filter((index) => index.flatIndexFieldMetadatas.some((part) => part.fieldMetadataId === field.id));
    expect(field.isUnique).toBe(false);
    expect(indexes).toHaveLength(1);
    expect(indexes[0].isUnique).toBe(false);
    const hydrated = { ...object,
      fieldIds: Object.values(maps.flatFieldMetadataMaps.byUniversalIdentifier).filter(isDefined).filter((entry) => entry.objectMetadataId === object.id).map((entry) => entry.id),
      indexMetadataIds: indexes.map((entry) => entry.id),
    };
    expect(getConflictingFields(hydrated, maps.flatFieldMetadataMaps, maps.flatIndexMaps).map((group) => group.baseFields)).toEqual([['id']]);
  }
});

// This URL must point to a disposable database: the suite creates its own random workspace schema.
const integration = process.env.CRM_DUPLICATES_TEST_DATABASE_URL ? describe : describe.skip;
integration('workspace uniqueness migration against PostgreSQL', () => {
  let db: DataSource;
  let maps: ReturnType<typeof buildMaps>;
  const flush = jest.fn();
  const version = jest.fn();
  const cache = { getOrRecompute: async () => maps, flush };
  const command = () => new AllowDuplicateCrmIdentitiesCommand({} as never, cache as never, { indexManager: new WorkspaceSchemaIndexManagerService() } as never, { incrementMetadataVersion: version } as never, db);
  beforeAll(async () => {
    jest.useRealTimers();
    db = new DataSource({ type: 'postgres', url: process.env.CRM_DUPLICATES_TEST_DATABASE_URL, entities: [
      new EntitySchema({ name: 'FieldMetadataEntity', target: FieldMetadataEntity, tableName: 'duplicate_test_fields', columns: { id: { type: 'uuid', primary: true }, workspaceId: { type: 'uuid' }, isUnique: { type: Boolean } } }),
      new EntitySchema({ name: 'IndexMetadataEntity', target: IndexMetadataEntity, tableName: 'duplicate_test_indexes', columns: { id: { type: 'uuid', primary: true }, workspaceId: { type: 'uuid' }, isUnique: { type: Boolean } } }),
    ] });
    await db.initialize();
    await db.synchronize();
  });
  beforeEach(async () => {
    maps = buildMaps();
    await db.query(`CREATE SCHEMA "${schema}"`);
    await db.query(`CREATE TABLE "${schema}".person (id uuid PRIMARY KEY, "emailsPrimaryEmail" text)`);
    await db.query(`CREATE TABLE "${schema}".company (id uuid PRIMARY KEY, "domainNamePrimaryLinkUrl" text)`);
    for (const uid of targets) {
      const field = maps.flatFieldMetadataMaps.byUniversalIdentifier[uid]!;
      const object = maps.flatObjectMetadataMaps.byUniversalIdentifier[field.objectMetadataUniversalIdentifier]!;
      const index = Object.values(maps.flatIndexMaps.byUniversalIdentifier).filter(isDefined).find((entry) => entry.flatIndexFieldMetadatas.some((part) => part.fieldMetadataId === field.id))!;
      field.isUnique = true;
      index.isUnique = true;
      const column = object.nameSingular === 'person' ? 'emailsPrimaryEmail' : 'domainNamePrimaryLinkUrl';
      await db.query(`CREATE UNIQUE INDEX "${index.name}" ON "${schema}"."${object.nameSingular}" ("${column}")`);
      await db.getRepository(FieldMetadataEntity).insert({ id: field.id, workspaceId, isUnique: true });
      await db.getRepository(IndexMetadataEntity).insert({ id: index.id, workspaceId, isUnique: true });
    }
  });
  afterEach(async () => {
    await db.query(`DROP SCHEMA "${schema}" CASCADE`);
    await db.query('TRUNCATE duplicate_test_fields, duplicate_test_indexes');
  });
  afterAll(async () => { await db.destroy(); });
  test('dry-run does not change metadata or physical uniqueness', async () => {
    await command().runOnWorkspace({ workspaceId, index: 0, total: 1, options: { dryRun: true } });
    expect(await db.getRepository(FieldMetadataEntity).countBy({ isUnique: true })).toBe(2);
    expect(flush).not.toHaveBeenCalled();
  });
  test('upgrade and rerun preserve rows, permit duplicates, and retain primary-key upserts', async () => {
    for (let run = 0; run < 2; run++) await command().runOnWorkspace({ workspaceId, index: 0, total: 1, options: {} });
    expect(await db.getRepository(FieldMetadataEntity).countBy({ isUnique: true })).toBe(0);
    expect(await db.getRepository(IndexMetadataEntity).countBy({ isUnique: true })).toBe(0);
    for (const [table, column, value] of [['person', 'emailsPrimaryEmail', 'same@example.test'], ['company', 'domainNamePrimaryLinkUrl', 'example.test']]) {
      await db.query(`INSERT INTO "${schema}"."${table}" (id, "${column}") VALUES ('00000000-0000-4000-8000-000000000001', $1), ('00000000-0000-4000-8000-000000000002', $1)`, [value]);
      await db.query(`INSERT INTO "${schema}"."${table}" (id, "${column}") VALUES ('00000000-0000-4000-8000-000000000001', $1) ON CONFLICT (id) DO UPDATE SET "${column}" = EXCLUDED."${column}"`, [value]);
      expect((await db.query(`SELECT count(*) FROM "${schema}"."${table}"`))[0].count).toBe('2');
    }
    expect(flush).toHaveBeenCalled();
    expect(version).toHaveBeenCalledWith(workspaceId);
  });
  test('an index rebuild failure rolls back metadata and earlier index changes', async () => {
    await db.query(`DROP TABLE "${schema}".company CASCADE`);
    await expect(command().runOnWorkspace({ workspaceId, index: 0, total: 1, options: {} })).rejects.toThrow();
    expect(await db.getRepository(FieldMetadataEntity).countBy({ isUnique: true })).toBe(2);
    expect(await db.getRepository(IndexMetadataEntity).countBy({ isUnique: true })).toBe(2);
    expect(flush).not.toHaveBeenCalled();
  });
});
