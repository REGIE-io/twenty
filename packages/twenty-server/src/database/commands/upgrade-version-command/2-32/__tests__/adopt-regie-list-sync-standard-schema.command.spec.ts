import { STANDARD_OBJECTS } from 'twenty-shared/metadata';
import {
  FieldMetadataType,
  RelationOnDeleteAction,
  RelationType,
} from 'twenty-shared/types';
import { isDefined } from 'twenty-shared/utils';

import { AdoptRegieListSyncStandardSchemaCommand } from 'src/database/commands/upgrade-version-command/2-32/2-32-workspace-command-1786900000000-adopt-regie-list-sync-standard-schema.command';
import { createEmptyFlatEntityMaps } from 'src/engine/metadata-modules/flat-entity/constant/create-empty-flat-entity-maps.constant';
import { type AllFlatEntityMaps } from 'src/engine/metadata-modules/flat-entity/types/all-flat-entity-maps.type';
import { type SyncableFlatEntity } from 'src/engine/metadata-modules/flat-entity/types/flat-entity-from.type';
import { type FlatEntityMaps } from 'src/engine/metadata-modules/flat-entity/types/flat-entity-maps.type';
import { addFlatEntityToFlatEntityMapsOrThrow } from 'src/engine/metadata-modules/flat-entity/utils/add-flat-entity-to-flat-entity-maps-or-throw.util';
import { isMorphOrRelationFlatFieldMetadata } from 'src/engine/metadata-modules/flat-field-metadata/utils/is-morph-or-relation-flat-field-metadata.util';
import { computeTwentyStandardApplicationAllFlatEntityMaps } from 'src/engine/workspace-manager/twenty-standard-application/utils/twenty-standard-application-all-flat-entity-maps.constant';

const WORKSPACE_ID = '20202020-1111-4111-8111-111111111111';
const STANDARD_APPLICATION_ID = '20202020-2222-4222-8222-222222222222';
const STANDARD_APPLICATION_UNIVERSAL_IDENTIFIER =
  '20202020-0000-4000-8000-000000000001';
const LEGACY_APPLICATION_ID = '20202020-3333-4333-8333-333333333333';
const LEGACY_APPLICATION_UNIVERSAL_IDENTIFIER =
  '20202020-0000-4000-8000-000000000002';

type RegieMaps = Pick<
  AllFlatEntityMaps,
  'flatObjectMetadataMaps' | 'flatFieldMetadataMaps' | 'flatIndexMaps'
>;

const rebuildMaps = <T extends SyncableFlatEntity>(
  entities: T[],
): FlatEntityMaps<T> =>
  entities.reduce(
    (maps, flatEntity) =>
      addFlatEntityToFlatEntityMapsOrThrow({
        flatEntity,
        flatEntityMaps: maps,
      }),
    createEmptyFlatEntityMaps() as FlatEntityMaps<T>,
  );

const currentMaps = (): RegieMaps => {
  const { allFlatEntityMaps } =
    computeTwentyStandardApplicationAllFlatEntityMaps({
      now: '2026-09-06T00:00:00.000Z',
      workspaceId: WORKSPACE_ID,
      twentyStandardApplicationId: STANDARD_APPLICATION_ID,
    });

  return {
    flatObjectMetadataMaps: allFlatEntityMaps.flatObjectMetadataMaps,
    flatFieldMetadataMaps: allFlatEntityMaps.flatFieldMetadataMaps,
    flatIndexMaps: allFlatEntityMaps.flatIndexMaps,
  };
};

const isRegieObjectName = (name: string) =>
  ['regieStaticList', 'regieListMembership', 'regieSyncSource'].includes(name);

const legacyMaps = (): RegieMaps => {
  const maps = currentMaps();
  const objects = Object.values(
    maps.flatObjectMetadataMaps.byUniversalIdentifier,
  ).filter(isDefined);
  const regieObjectIds = new Set(
    objects
      .filter(({ nameSingular }) => isRegieObjectName(nameSingular))
      .map(({ id }) => id),
  );
  const objectNameById = new Map(
    objects.map(({ id, nameSingular }) => [id, nameSingular]),
  );
  const changedObjectUniversalIdentifierById = new Map<string, string>();
  const legacyObjects = objects.map((object) => {
    if (!regieObjectIds.has(object.id)) return object;
    const universalIdentifier = `legacy-object-${object.nameSingular}`;

    changedObjectUniversalIdentifierById.set(object.id, universalIdentifier);

    return {
      ...object,
      universalIdentifier,
      applicationId: LEGACY_APPLICATION_ID,
      applicationUniversalIdentifier: LEGACY_APPLICATION_UNIVERSAL_IDENTIFIER,
      isUICreatable: true,
      isUIEditable: true,
    };
  });
  const legacyFields = Object.values(
    maps.flatFieldMetadataMaps.byUniversalIdentifier,
  )
    .filter(isDefined)
    .map((field) => {
      const objectName = objectNameById.get(field.objectMetadataId);
      const isInverse =
        ['person', 'company', 'task'].includes(objectName ?? '') &&
        ['regieListMemberships', 'regieSyncSources'].includes(field.name);

      if (!regieObjectIds.has(field.objectMetadataId) && !isInverse)
        return field;

      return {
        ...field,
        universalIdentifier: `legacy-field-${objectName}-${field.name}`,
        applicationId: LEGACY_APPLICATION_ID,
        applicationUniversalIdentifier: LEGACY_APPLICATION_UNIVERSAL_IDENTIFIER,
        objectMetadataUniversalIdentifier:
          changedObjectUniversalIdentifierById.get(field.objectMetadataId) ??
          field.objectMetadataUniversalIdentifier,
      };
    });
  const legacyIndexes = Object.values(maps.flatIndexMaps.byUniversalIdentifier)
    .filter(isDefined)
    .map((index) => {
      if (!regieObjectIds.has(index.objectMetadataId)) return index;

      return {
        ...index,
        universalIdentifier: `legacy-index-${index.name}`,
        applicationId: LEGACY_APPLICATION_ID,
        applicationUniversalIdentifier: LEGACY_APPLICATION_UNIVERSAL_IDENTIFIER,
        objectMetadataUniversalIdentifier:
          changedObjectUniversalIdentifierById.get(index.objectMetadataId) ??
          index.objectMetadataUniversalIdentifier,
      };
    });

  return {
    flatObjectMetadataMaps: rebuildMaps(legacyObjects),
    flatFieldMetadataMaps: rebuildMaps(legacyFields),
    flatIndexMaps: rebuildMaps(legacyIndexes),
  };
};

describe('AdoptRegieListSyncStandardSchemaCommand', () => {
  const validateBuildAndRunTwentyStandardWorkspaceMigration = jest.fn();
  const validateBuildAndRunWorkspaceMigration = jest.fn();
  const validateAndRunWorkspaceMigrationIdentityReassignment = jest.fn();
  let maps: RegieMaps;
  let command: AdoptRegieListSyncStandardSchemaCommand;

  beforeEach(() => {
    jest.clearAllMocks();
    maps = legacyMaps();
    validateBuildAndRunTwentyStandardWorkspaceMigration.mockResolvedValue({
      status: 'success',
      hasSchemaMetadataChanged: true,
      workspaceMigration: { actions: [] },
    });
    validateBuildAndRunWorkspaceMigration.mockResolvedValue({
      status: 'success',
      hasSchemaMetadataChanged: true,
      workspaceMigration: { actions: [] },
    });
    validateAndRunWorkspaceMigrationIdentityReassignment.mockResolvedValue({
      hasSchemaMetadataChanged: true,
    });
    command = new AdoptRegieListSyncStandardSchemaCommand(
      {} as never,
      {
        findWorkspaceTwentyStandardAndCustomApplicationOrThrow: jest
          .fn()
          .mockResolvedValue({
            twentyStandardFlatApplication: {
              id: STANDARD_APPLICATION_ID,
              universalIdentifier: STANDARD_APPLICATION_UNIVERSAL_IDENTIFIER,
            },
          }),
      } as never,
      {
        getOrRecompute: jest.fn().mockImplementation(async () => maps),
      } as never,
      {
        validateBuildAndRunTwentyStandardWorkspaceMigration,
        validateBuildAndRunWorkspaceMigration,
        validateAndRunWorkspaceMigrationIdentityReassignment,
      } as never,
    );
  });

  const run = (dryRun = false) =>
    command.runOnWorkspace({
      workspaceId: WORKSPACE_ID,
      index: 0,
      total: 1,
      options: { dryRun } as never,
    });

  it('creates the complete schema when no Regie object exists', async () => {
    const current = currentMaps();

    maps = {
      flatObjectMetadataMaps: rebuildMaps(
        Object.values(
          current.flatObjectMetadataMaps.byUniversalIdentifier,
        )
          .filter(isDefined)
          .filter(({ nameSingular }) =>
            [
              'person',
              'company',
              'task',
              'timelineActivity',
              'attachment',
              'noteTarget',
              'taskTarget',
            ].includes(nameSingular),
          ),
      ),
      flatFieldMetadataMaps: createEmptyFlatEntityMaps(),
      flatIndexMaps: createEmptyFlatEntityMaps(),
    };

    await run();

    const [{ allFlatEntityOperationByMetadataName }] =
      validateBuildAndRunTwentyStandardWorkspaceMigration.mock.calls[0];

    expect(
      allFlatEntityOperationByMetadataName.objectMetadata.flatEntityToCreate,
    ).toHaveLength(3);
    expect(
      allFlatEntityOperationByMetadataName.fieldMetadata.flatEntityToCreate,
    ).toHaveLength(64);
    expect(
      allFlatEntityOperationByMetadataName.index.flatEntityToCreate,
    ).toHaveLength(3);
    expect(
      validateBuildAndRunTwentyStandardWorkspaceMigration,
    ).toHaveBeenCalledWith(
      expect.not.objectContaining({ isSystemBuild: expect.anything() }),
    );
    expect(
      validateAndRunWorkspaceMigrationIdentityReassignment,
    ).not.toHaveBeenCalled();
  });

  it('defers creation when core relation objects are unavailable', async () => {
    maps = {
      flatObjectMetadataMaps: createEmptyFlatEntityMaps(),
      flatFieldMetadataMaps: createEmptyFlatEntityMaps(),
      flatIndexMaps: createEmptyFlatEntityMaps(),
    };

    await run();

    expect(
      validateBuildAndRunTwentyStandardWorkspaceMigration,
    ).not.toHaveBeenCalled();
    expect(validateBuildAndRunWorkspaceMigration).not.toHaveBeenCalled();
  });

  it('adopts compatible legacy metadata and then locks object schema editing', async () => {
    await run();

    const [{ identityReassignments }] =
      validateAndRunWorkspaceMigrationIdentityReassignment.mock.calls[0];

    expect(
      identityReassignments.filter(
        ({ metadataName }: { metadataName: string }) =>
          metadataName === 'objectMetadata',
      ),
    ).toHaveLength(3);
    expect(
      identityReassignments.filter(
        ({ metadataName }: { metadataName: string }) =>
          metadataName === 'fieldMetadata',
      ),
    ).toHaveLength(64);
    expect(
      identityReassignments.filter(
        ({ metadataName }: { metadataName: string }) =>
          metadataName === 'index',
      ),
    ).toHaveLength(3);
    expect(validateBuildAndRunWorkspaceMigration).toHaveBeenCalledTimes(1);
    expect(
      validateBuildAndRunWorkspaceMigration.mock.calls[0][0]
        .allFlatEntityOperationByMetadataName.objectMetadata.flatEntityToUpdate,
    ).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          nameSingular: 'regieStaticList',
          isUICreatable: false,
          isUIEditable: false,
        }),
      ]),
    );
  });

  it('is a no-op when the workspace is already current', async () => {
    maps = currentMaps();

    await run();

    expect(
      validateAndRunWorkspaceMigrationIdentityReassignment,
    ).not.toHaveBeenCalled();
    expect(validateBuildAndRunWorkspaceMigration).not.toHaveBeenCalled();
  });

  it('passes dry-run through without applying object updates', async () => {
    await run(true);

    expect(
      validateAndRunWorkspaceMigrationIdentityReassignment,
    ).toHaveBeenCalledWith(expect.objectContaining({ dryRun: true }));
    expect(validateBuildAndRunWorkspaceMigration).not.toHaveBeenCalled();
  });

  it('fails closed on a partial object set', async () => {
    maps.flatObjectMetadataMaps = rebuildMaps(
      Object.values(maps.flatObjectMetadataMaps.byUniversalIdentifier)
        .filter(isDefined)
        .filter(({ nameSingular }) => nameSingular !== 'regieSyncSource'),
    );

    await expect(run()).rejects.toThrow('Partial Regie schema');
    expect(
      validateAndRunWorkspaceMigrationIdentityReassignment,
    ).not.toHaveBeenCalled();
  });

  it('fails closed on a duplicate durable object name', async () => {
    const object = Object.values(
      maps.flatObjectMetadataMaps.byUniversalIdentifier,
    )
      .filter(isDefined)
      .find(({ nameSingular }) => nameSingular === 'regieStaticList');

    maps.flatObjectMetadataMaps = rebuildMaps([
      ...Object.values(
        maps.flatObjectMetadataMaps.byUniversalIdentifier,
      ).filter(isDefined),
      {
        ...object!,
        id: 'duplicate-object-id',
        universalIdentifier: 'duplicate-object-ui',
      },
    ]);

    await expect(run()).rejects.toThrow(
      'Duplicate Regie object regieStaticList',
    );
  });

  it('fails closed on a wrong scalar field type', async () => {
    maps.flatFieldMetadataMaps = rebuildMaps(
      Object.values(maps.flatFieldMetadataMaps.byUniversalIdentifier)
        .filter(isDefined)
        .map((field) =>
          field.name === 'membershipKey'
            ? { ...field, type: FieldMetadataType.NUMBER }
            : field,
        ),
    );

    await expect(run()).rejects.toThrow('regieListMembership.membershipKey');
  });

  it('fails closed on a duplicate durable field name', async () => {
    const membershipKey = Object.values(
      maps.flatFieldMetadataMaps.byUniversalIdentifier,
    )
      .filter(isDefined)
      .find(({ name }) => name === 'membershipKey');

    maps.flatFieldMetadataMaps = rebuildMaps([
      ...Object.values(maps.flatFieldMetadataMaps.byUniversalIdentifier).filter(
        isDefined,
      ),
      {
        ...membershipKey!,
        id: 'duplicate-field-id',
        universalIdentifier: 'duplicate-field-ui',
      },
    ]);

    await expect(run()).rejects.toThrow(
      'regieListMembership.membershipKey: expected exactly one active field, received 2',
    );
  });

  it('fails closed on incompatible select options', async () => {
    maps.flatFieldMetadataMaps = rebuildMaps(
      Object.values(maps.flatFieldMetadataMaps.byUniversalIdentifier)
        .filter(isDefined)
        .map((field) =>
          field.name === 'targetType'
            ? { ...field, options: field.options?.slice(0, 2) ?? null }
            : field,
        ),
    );

    await expect(run()).rejects.toThrow('select options');
  });

  it('fails closed on a wrong relation target', async () => {
    const company = Object.values(
      maps.flatObjectMetadataMaps.byUniversalIdentifier,
    )
      .filter(isDefined)
      .find(({ nameSingular }) => nameSingular === 'company');

    maps.flatFieldMetadataMaps = rebuildMaps(
      Object.values(maps.flatFieldMetadataMaps.byUniversalIdentifier)
        .filter(isDefined)
        .map((field) =>
          isMorphOrRelationFlatFieldMetadata(field) &&
          field.name === 'person' &&
          Object.values(maps.flatObjectMetadataMaps.byUniversalIdentifier)
            .filter(isDefined)
            .find(({ id }) => id === field.objectMetadataId)?.nameSingular ===
            'regieListMembership'
            ? { ...field, relationTargetObjectMetadataId: company!.id }
            : field,
        ),
    );

    await expect(run()).rejects.toThrow('relation regieListMembership.person');
  });

  it('fails closed on a wrong relation cardinality', async () => {
    maps.flatFieldMetadataMaps = rebuildMaps(
      Object.values(maps.flatFieldMetadataMaps.byUniversalIdentifier)
        .filter(isDefined)
        .map((field) =>
          isMorphOrRelationFlatFieldMetadata(field) &&
          field.name === 'person' &&
          field.settings?.relationType === RelationType.MANY_TO_ONE
            ? {
                ...field,
                settings: {
                  ...field.settings,
                  relationType: RelationType.ONE_TO_MANY,
                },
              }
            : field,
        ),
    );

    await expect(run()).rejects.toThrow('relation regieListMembership.person');
  });

  it('fails closed on a wrong relation delete action', async () => {
    maps.flatFieldMetadataMaps = rebuildMaps(
      Object.values(maps.flatFieldMetadataMaps.byUniversalIdentifier)
        .filter(isDefined)
        .map((field) =>
          isMorphOrRelationFlatFieldMetadata(field) &&
          field.name === 'person' &&
          field.settings?.relationType === RelationType.MANY_TO_ONE
            ? {
                ...field,
                settings: {
                  ...field.settings,
                  onDelete: RelationOnDeleteAction.SET_NULL,
                },
              }
            : field,
        ),
    );

    await expect(run()).rejects.toThrow('relation regieListMembership.person');
  });

  it('fails closed on a missing or incompatible explicit index', async () => {
    maps.flatIndexMaps = rebuildMaps(
      Object.values(maps.flatIndexMaps.byUniversalIdentifier)
        .filter(isDefined)
        .map((index) =>
          index.isUnique &&
          index.flatIndexFieldMetadatas.some(({ fieldMetadataId }) =>
            Object.values(maps.flatFieldMetadataMaps.byUniversalIdentifier)
              .filter(isDefined)
              .some(
                ({ id, name }) =>
                  id === fieldMetadataId && name === 'sourceKey',
              ),
          )
            ? { ...index, isUnique: false }
            : index,
        ),
    );

    await expect(run()).rejects.toThrow('Incompatible Regie index');
  });

  it('fails closed when duplicate compatible indexes exist', async () => {
    const membershipIndex = Object.values(
      maps.flatIndexMaps.byUniversalIdentifier,
    )
      .filter(isDefined)
      .find((index) =>
        index.flatIndexFieldMetadatas.some(({ fieldMetadataId }) =>
          Object.values(maps.flatFieldMetadataMaps.byUniversalIdentifier)
            .filter(isDefined)
            .some(
              ({ id, name }) =>
                id === fieldMetadataId && name === 'membershipKey',
            ),
        ),
      );

    maps.flatIndexMaps = rebuildMaps([
      ...Object.values(maps.flatIndexMaps.byUniversalIdentifier).filter(
        isDefined,
      ),
      {
        ...membershipIndex!,
        id: 'duplicate-index-id',
        universalIdentifier: 'duplicate-index-ui',
      },
    ]);

    await expect(run()).rejects.toThrow('received 2');
  });

  it('targets the stable standard identifiers while preserving legacy entity IDs', async () => {
    const originalObjects = Object.values(
      maps.flatObjectMetadataMaps.byUniversalIdentifier,
    ).filter(isDefined);

    await run();

    const [{ identityReassignments }] =
      validateAndRunWorkspaceMigrationIdentityReassignment.mock.calls[0];
    const objectReassignments = identityReassignments.filter(
      ({ metadataName }: { metadataName: string }) =>
        metadataName === 'objectMetadata',
    );

    expect(objectReassignments).toEqual(
      expect.arrayContaining(
        originalObjects
          .filter(({ nameSingular }) => isRegieObjectName(nameSingular))
          .map((object) => ({
            metadataName: 'objectMetadata',
            sourceUniversalIdentifier: object.universalIdentifier,
            targetUniversalIdentifier:
              STANDARD_OBJECTS[
                object.nameSingular as
                  | 'regieStaticList'
                  | 'regieListMembership'
                  | 'regieSyncSource'
              ].universalIdentifier,
          })),
      ),
    );
  });

  it('resumes after identity adoption if object locking was interrupted', async () => {
    const current = currentMaps();

    current.flatObjectMetadataMaps = rebuildMaps(
      Object.values(current.flatObjectMetadataMaps.byUniversalIdentifier)
        .filter(isDefined)
        .map((object) =>
          isRegieObjectName(object.nameSingular)
            ? { ...object, isUICreatable: true, isUIEditable: true }
            : object,
        ),
    );
    maps = current;

    await run();

    expect(
      validateAndRunWorkspaceMigrationIdentityReassignment,
    ).not.toHaveBeenCalled();
    expect(validateBuildAndRunWorkspaceMigration).toHaveBeenCalledTimes(1);
  });
});
