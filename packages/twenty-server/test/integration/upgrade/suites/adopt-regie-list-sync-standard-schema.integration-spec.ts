import { v4 } from 'uuid';

import { STANDARD_OBJECTS } from 'twenty-shared/metadata';
import { isDefined } from 'twenty-shared/utils';

import { AdoptRegieListSyncStandardSchemaCommand } from 'src/database/commands/upgrade-version-command/2-32/2-32-workspace-command-1786900000000-adopt-regie-list-sync-standard-schema.command';
import { ApplicationService } from 'src/engine/core-modules/application/application.service';
import { FieldMetadataEntity } from 'src/engine/metadata-modules/field-metadata/field-metadata.entity';
import { IndexMetadataEntity } from 'src/engine/metadata-modules/index-metadata/index-metadata.entity';
import { ObjectMetadataEntity } from 'src/engine/metadata-modules/object-metadata/object-metadata.entity';
import { getWorkspaceSchemaName } from 'src/engine/workspace-datasource/utils/get-workspace-schema-name.util';
import { computeTableName } from 'src/engine/utils/compute-table-name.util';
import { WorkspaceCacheService } from 'src/engine/workspace-cache/services/workspace-cache.service';
import { SEED_APPLE_WORKSPACE_ID } from 'src/engine/workspace-manager/dev-seeder/core/constants/seeder-workspaces.constant';
import { WorkspaceMigrationValidateBuildAndRunService } from 'src/engine/workspace-manager/workspace-migration/services/workspace-migration-validate-build-and-run-service';
import { WorkspaceMigrationRunnerService } from 'src/engine/workspace-manager/workspace-migration/workspace-migration-runner/services/workspace-migration-runner.service';

import { getCoreRepository } from 'test/integration/utils/get-core-repository.util';
import { getAppProviderByClassName } from 'test/integration/utils/get-app-provider-by-class-name.util';

// Jest 29 cannot resolve file-type's ESM-only export map. This suite does not
// exercise file inspection, but ApplicationService imports the file stack.
jest.mock(
  'file-type',
  () => ({
    FileTypeParser: class {
      async fromBuffer() {
        return undefined;
      }
    },
    supportedMimeTypes: new Set(),
  }),
  { virtual: true },
);
jest.mock('@file-type/pdf', () => ({ detectPdf: {} }));

const REGIE_OBJECT_NAMES = [
  'regieStaticList',
  'regieListMembership',
  'regieSyncSource',
] as const;
const RECORD_ID = '20202020-4444-4444-8444-444444444444';

type PreservedIdentity = {
  id: string;
  universalIdentifier: string;
  applicationId: string;
};

describe('Regie standard schema adoption (integration)', () => {
  const objectRepository =
    getCoreRepository<ObjectMetadataEntity>(ObjectMetadataEntity);
  const fieldRepository =
    getCoreRepository<FieldMetadataEntity>(FieldMetadataEntity);
  const indexRepository =
    getCoreRepository<IndexMetadataEntity>(IndexMetadataEntity);
  const schemaName = getWorkspaceSchemaName(SEED_APPLE_WORKSPACE_ID);
  const originalObjects: ObjectMetadataEntity[] = [];
  const originalFields: FieldMetadataEntity[] = [];
  const originalIndexes: IndexMetadataEntity[] = [];
  let tableName: string;
  let tableOid: string;
  let physicalIndexesBefore: Array<{ oid: string; indexname: string }>;
  let metadataIdentityBefore: PreservedIdentity[];
  let command: AdoptRegieListSyncStandardSchemaCommand;
  let workspaceMigrationRunnerService: WorkspaceMigrationRunnerService;
  let workspaceMigrationService: WorkspaceMigrationValidateBuildAndRunService;
  let standardApplicationUniversalIdentifier: string;
  let legacyIdentityById: Map<
    string,
    {
      metadataName: 'objectMetadata' | 'fieldMetadata' | 'index';
      legacy: string;
    }
  >;

  const invalidateMetadataCache = async () => {
    await workspaceMigrationRunnerService.invalidateCache({
      workspaceId: SEED_APPLE_WORKSPACE_ID,
      allFlatEntityMapsKeys: [
        'flatObjectMetadataMaps',
        'flatFieldMetadataMaps',
        'flatIndexMaps',
      ],
    });
  };

  beforeAll(async () => {
    workspaceMigrationRunnerService =
      getAppProviderByClassName<WorkspaceMigrationRunnerService>(
        'WorkspaceMigrationRunnerService',
      );
    const applicationService =
      getAppProviderByClassName<ApplicationService>('ApplicationService');
    workspaceMigrationService =
      getAppProviderByClassName<WorkspaceMigrationValidateBuildAndRunService>(
        'WorkspaceMigrationValidateBuildAndRunService',
      );
    command = new AdoptRegieListSyncStandardSchemaCommand(
      {} as never,
      applicationService,
      getAppProviderByClassName<WorkspaceCacheService>('WorkspaceCacheService'),
      workspaceMigrationService,
    );
    const { twentyStandardFlatApplication, workspaceCustomFlatApplication } =
      await applicationService.findWorkspaceTwentyStandardAndCustomApplicationOrThrow(
        { workspaceId: SEED_APPLE_WORKSPACE_ID },
      );
    standardApplicationUniversalIdentifier =
      twentyStandardFlatApplication.universalIdentifier;
    const objects = await objectRepository.find({
      where: { workspaceId: SEED_APPLE_WORKSPACE_ID },
    });

    originalObjects.push(
      ...objects.filter(({ nameSingular }) =>
        REGIE_OBJECT_NAMES.includes(
          nameSingular as (typeof REGIE_OBJECT_NAMES)[number],
        ),
      ),
    );
    expect(originalObjects).toHaveLength(3);

    const regieObjectIds = new Set(originalObjects.map(({ id }) => id));
    const standardTargetObjectIds = new Set(
      objects
        .filter(({ nameSingular }) =>
          ['person', 'company', 'task'].includes(nameSingular),
        )
        .map(({ id }) => id),
    );
    const fields = await fieldRepository.find({
      where: { workspaceId: SEED_APPLE_WORKSPACE_ID },
    });

    originalFields.push(
      ...fields.filter(
        ({ objectMetadataId, name }) =>
          regieObjectIds.has(objectMetadataId) ||
          (standardTargetObjectIds.has(objectMetadataId) &&
            ['regieListMemberships', 'regieSyncSources'].includes(name)),
      ),
    );
    const indexes = await indexRepository.find({
      where: { workspaceId: SEED_APPLE_WORKSPACE_ID },
      relations: { indexFieldMetadatas: true },
    });
    const explicitIndexUniversalIdentifiers = new Set<string>([
      STANDARD_OBJECTS.regieListMembership.indexes.membershipKeyUniqueIndex
        .universalIdentifier,
      STANDARD_OBJECTS.regieSyncSource.indexes.sourceKeyUniqueIndex
        .universalIdentifier,
      STANDARD_OBJECTS.regieSyncSource.indexes.externalRecordLookupIndex
        .universalIdentifier,
    ]);

    originalIndexes.push(
      ...indexes.filter(({ universalIdentifier }) =>
        explicitIndexUniversalIdentifiers.has(universalIdentifier),
      ),
    );
    expect(originalIndexes).toHaveLength(3);

    metadataIdentityBefore = [
      ...originalObjects,
      ...originalFields,
      ...originalIndexes,
    ].map(({ id, universalIdentifier, applicationId }) => ({
      id,
      universalIdentifier,
      applicationId,
    }));

    legacyIdentityById = new Map(
      [
        ...originalObjects.map((entity) => ({
          entity,
          metadataName: 'objectMetadata' as const,
        })),
        ...originalFields.map((entity) => ({
          entity,
          metadataName: 'fieldMetadata' as const,
        })),
        ...originalIndexes.map((entity) => ({
          entity,
          metadataName: 'index' as const,
        })),
      ].map(({ entity, metadataName }) => [
        entity.id,
        { metadataName, legacy: v4() },
      ]),
    );
    await workspaceMigrationService.validateAndRunWorkspaceMigrationIdentityReassignment(
      {
        workspaceId: SEED_APPLE_WORKSPACE_ID,
        applicationUniversalIdentifier:
          workspaceCustomFlatApplication.universalIdentifier,
        identityReassignments: metadataIdentityBefore.map(
          ({ id, universalIdentifier }) => ({
            metadataName: legacyIdentityById.get(id)!.metadataName,
            sourceUniversalIdentifier: universalIdentifier,
            targetUniversalIdentifier: legacyIdentityById.get(id)!.legacy,
          }),
        ),
      },
    );
    await objectRepository.update(
      originalObjects.map(({ id }) => id),
      { isUICreatable: true, isUIEditable: true },
    );

    if (isDefined(workspaceMigrationRunnerService)) {
      await invalidateMetadataCache();
    }

    const staticList = originalObjects.find(
      ({ nameSingular }) => nameSingular === 'regieStaticList',
    );

    if (!isDefined(staticList)) {
      throw new Error('regieStaticList is missing');
    }

    tableName = computeTableName(staticList.nameSingular, true);
    await global.testDataSource.query(
      `INSERT INTO "${schemaName}"."${tableName}" ("id", "name") VALUES ($1, $2)`,
      [RECORD_ID, 'Preserved adoption record'],
    );
    const [{ oid }] = await global.testDataSource.query(
      'SELECT to_regclass($1)::oid::text AS oid',
      [`"${schemaName}"."${tableName}"`],
    );

    tableOid = oid;
    physicalIndexesBefore = await global.testDataSource.query(
      'SELECT pg_class.oid::text AS oid, indexname FROM pg_indexes JOIN pg_namespace ON pg_namespace.nspname = schemaname JOIN pg_class ON pg_class.relnamespace = pg_namespace.oid AND pg_class.relname = indexname WHERE schemaname = $1 AND tablename = ANY($2) ORDER BY indexname',
      [
        schemaName,
        REGIE_OBJECT_NAMES.map((name) => computeTableName(name, true)),
      ],
    );
    expect(twentyStandardFlatApplication.id).toBeDefined();
  }, 60000);

  afterAll(async () => {
    if (
      isDefined(workspaceMigrationService) &&
      isDefined(legacyIdentityById) &&
      metadataIdentityBefore?.length > 0
    ) {
      const currentEntities = [
        ...(await objectRepository.findByIds(
          originalObjects.map(({ id }) => id),
        )),
        ...(await fieldRepository.findByIds(
          originalFields.map(({ id }) => id),
        )),
        ...(await indexRepository.findByIds(
          originalIndexes.map(({ id }) => id),
        )),
      ];
      const currentById = new Map(
        currentEntities.map((entity) => [entity.id, entity]),
      );

      await workspaceMigrationService.validateAndRunWorkspaceMigrationIdentityReassignment(
        {
          workspaceId: SEED_APPLE_WORKSPACE_ID,
          applicationUniversalIdentifier:
            standardApplicationUniversalIdentifier,
          identityReassignments: metadataIdentityBefore.map(
            ({ id, universalIdentifier }) => ({
              metadataName: legacyIdentityById.get(id)!.metadataName,
              sourceUniversalIdentifier:
                currentById.get(id)!.universalIdentifier,
              targetUniversalIdentifier: universalIdentifier,
            }),
          ),
        },
      );
    }
    if (isDefined(tableName)) {
      const restoredTableName = computeTableName('regieStaticList', false);

      await global.testDataSource.query(
        `DELETE FROM "${schemaName}"."${restoredTableName}" WHERE "id" = $1`,
        [RECORD_ID],
      );
    }

    for (const object of originalObjects) {
      await objectRepository.update(object.id, {
        universalIdentifier: object.universalIdentifier,
        applicationId: object.applicationId,
        isUICreatable: object.isUICreatable,
        isUIEditable: object.isUIEditable,
      });
    }
    for (const field of originalFields) {
      await fieldRepository.update(field.id, {
        universalIdentifier: field.universalIdentifier,
        applicationId: field.applicationId,
      });
    }
    for (const index of originalIndexes) {
      await indexRepository.update(index.id, {
        universalIdentifier: index.universalIdentifier,
        applicationId: index.applicationId,
      });
    }
    if (isDefined(workspaceMigrationRunnerService)) {
      await invalidateMetadataCache();
    }
  }, 30000);

  it('adopts legacy metadata without changing IDs, tables, indexes, or records', async () => {
    await command.runOnWorkspace({
      workspaceId: SEED_APPLE_WORKSPACE_ID,
      index: 0,
      total: 1,
      options: { dryRun: false } as never,
    });

    const adoptedObjects = await objectRepository.find({
      where: { workspaceId: SEED_APPLE_WORKSPACE_ID },
    });
    const adoptedFields = await fieldRepository.find({
      where: { workspaceId: SEED_APPLE_WORKSPACE_ID },
    });
    const adoptedIndexes = await indexRepository.find({
      where: { workspaceId: SEED_APPLE_WORKSPACE_ID },
    });
    const adoptedById = new Map(
      [...adoptedObjects, ...adoptedFields, ...adoptedIndexes].map((entity) => [
        entity.id,
        entity,
      ]),
    );

    for (const preserved of metadataIdentityBefore) {
      const adopted = adoptedById.get(preserved.id);

      expect(adopted?.id).toBe(preserved.id);
      expect(adopted?.applicationId).toBe(originalObjects[0].applicationId);
      expect(adopted?.universalIdentifier).toBe(preserved.universalIdentifier);
    }

    for (const objectName of REGIE_OBJECT_NAMES) {
      const adopted = adoptedObjects.find(
        ({ nameSingular }) => nameSingular === objectName,
      );

      expect(adopted).toMatchObject({
        universalIdentifier: STANDARD_OBJECTS[objectName].universalIdentifier,
        isUICreatable: false,
        isUIEditable: false,
      });
    }

    const adoptedTableName = computeTableName('regieStaticList', false);
    const [{ oid: adoptedTableOid }] = await global.testDataSource.query(
      'SELECT to_regclass($1)::oid::text AS oid',
      [`"${schemaName}"."${adoptedTableName}"`],
    );
    const physicalIndexesAfter = await global.testDataSource.query(
      'SELECT pg_class.oid::text AS oid, indexname FROM pg_indexes JOIN pg_namespace ON pg_namespace.nspname = schemaname JOIN pg_class ON pg_class.relnamespace = pg_namespace.oid AND pg_class.relname = indexname WHERE schemaname = $1 AND tablename = ANY($2) ORDER BY indexname',
      [
        schemaName,
        REGIE_OBJECT_NAMES.map((name) => computeTableName(name, false)),
      ],
    );
    const records = await global.testDataSource.query(
      `SELECT "id", "name" FROM "${schemaName}"."${adoptedTableName}" WHERE "id" = $1`,
      [RECORD_ID],
    );

    expect(adoptedTableOid).toBe(tableOid);
    expect(physicalIndexesAfter).toEqual(physicalIndexesBefore);
    expect(records).toEqual([
      { id: RECORD_ID, name: 'Preserved adoption record' },
    ]);
  }, 60000);

  it('reruns as an already-current no-op', async () => {
    const updatedAtBefore = await objectRepository.find({
      where: { workspaceId: SEED_APPLE_WORKSPACE_ID },
      select: { id: true, updatedAt: true, nameSingular: true },
    });

    await command.runOnWorkspace({
      workspaceId: SEED_APPLE_WORKSPACE_ID,
      index: 0,
      total: 1,
      options: { dryRun: false } as never,
    });

    const updatedAtAfter = await objectRepository.find({
      where: { workspaceId: SEED_APPLE_WORKSPACE_ID },
      select: { id: true, updatedAt: true, nameSingular: true },
    });
    const relevant = (objects: ObjectMetadataEntity[]) =>
      objects
        .filter(({ nameSingular }) =>
          REGIE_OBJECT_NAMES.includes(
            nameSingular as (typeof REGIE_OBJECT_NAMES)[number],
          ),
        )
        .map(({ id, updatedAt }) => ({ id, updatedAt }));

    expect(relevant(updatedAtAfter)).toEqual(relevant(updatedAtBefore));
  });
});
