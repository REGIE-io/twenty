import { Command } from 'nest-commander';

import { STANDARD_OBJECTS } from 'twenty-shared/metadata';
import { FieldMetadataType, RelationType } from 'twenty-shared/types';
import { isDefined } from 'twenty-shared/utils';

import { ProvisionedWorkspaceCommandRunner } from 'src/database/commands/command-runners/provisioned-workspace.command-runner';
import { WorkspaceIteratorService } from 'src/database/commands/command-runners/workspace-iterator.service';
import { type RunOnWorkspaceArgs } from 'src/database/commands/command-runners/workspace.command-runner';
import { ApplicationService } from 'src/engine/core-modules/application/application.service';
import { RegisteredWorkspaceCommand } from 'src/engine/core-modules/upgrade/decorators/registered-workspace-command.decorator';
import { type AllFlatEntityMaps } from 'src/engine/metadata-modules/flat-entity/types/all-flat-entity-maps.type';
import { type FlatFieldMetadata } from 'src/engine/metadata-modules/flat-field-metadata/types/flat-field-metadata.type';
import { type FlatIndexMetadata } from 'src/engine/metadata-modules/flat-index-metadata/types/flat-index-metadata.type';
import { type FlatObjectMetadata } from 'src/engine/metadata-modules/flat-object-metadata/types/flat-object-metadata.type';
import { isMorphOrRelationFlatFieldMetadata } from 'src/engine/metadata-modules/flat-field-metadata/utils/is-morph-or-relation-flat-field-metadata.util';
import { WorkspaceCacheService } from 'src/engine/workspace-cache/services/workspace-cache.service';
import { computeTwentyStandardApplicationAllFlatEntityMaps } from 'src/engine/workspace-manager/twenty-standard-application/utils/twenty-standard-application-all-flat-entity-maps.constant';
import {
  type WorkspaceMigrationIdentityReassignment,
  WorkspaceMigrationValidateBuildAndRunService,
} from 'src/engine/workspace-manager/workspace-migration/services/workspace-migration-validate-build-and-run-service';

type RegieFlatEntityMaps = Pick<
  AllFlatEntityMaps,
  'flatObjectMetadataMaps' | 'flatFieldMetadataMaps' | 'flatIndexMaps'
>;

const REGIE_OBJECT_NAMES = [
  'regieStaticList',
  'regieListMembership',
  'regieSyncSource',
] as const;

const REGIE_OBJECT_UNIVERSAL_IDENTIFIERS = new Set(
  REGIE_OBJECT_NAMES.map(
    (objectName) => STANDARD_OBJECTS[objectName].universalIdentifier,
  ),
);

const REGIE_RELATION_PREREQUISITE_OBJECT_NAMES = [
  'person',
  'company',
  'task',
] as const;

const REGIE_INVERSE_FIELDS = new Set([
  'person.regieListMemberships',
  'person.regieSyncSources',
  'company.regieListMemberships',
  'company.regieSyncSources',
  'task.regieListMemberships',
  'task.regieSyncSources',
]);

const values = <T>(record: Record<string, T | undefined>): T[] =>
  Object.values(record).filter(isDefined);

const getObjectFields = ({
  allFlatEntityMaps,
  objectMetadataId,
}: {
  allFlatEntityMaps: Pick<AllFlatEntityMaps, 'flatFieldMetadataMaps'>;
  objectMetadataId: string;
}): FlatFieldMetadata[] =>
  values(allFlatEntityMaps.flatFieldMetadataMaps.byUniversalIdentifier).filter(
    (field) => field.objectMetadataId === objectMetadataId,
  );

const getObjectById = ({
  allFlatEntityMaps,
  objectMetadataId,
}: {
  allFlatEntityMaps: Pick<AllFlatEntityMaps, 'flatObjectMetadataMaps'>;
  objectMetadataId: string;
}): FlatObjectMetadata => {
  const object = values(
    allFlatEntityMaps.flatObjectMetadataMaps.byUniversalIdentifier,
  ).find(({ id }) => id === objectMetadataId);

  if (!isDefined(object)) {
    throw new Error(`object metadata ${objectMetadataId} does not exist`);
  }

  return object;
};

const assertCompatibleField = ({
  actualField,
  expectedField,
  actualAllFlatEntityMaps,
  expectedAllFlatEntityMaps,
}: {
  actualField: FlatFieldMetadata;
  expectedField: FlatFieldMetadata;
  actualAllFlatEntityMaps: RegieFlatEntityMaps;
  expectedAllFlatEntityMaps: RegieFlatEntityMaps;
}): void => {
  const fieldPath = `${getObjectById({ allFlatEntityMaps: actualAllFlatEntityMaps, objectMetadataId: actualField.objectMetadataId }).nameSingular}.${actualField.name}`;

  if (
    actualField.type !== expectedField.type ||
    actualField.isNullable !== expectedField.isNullable
  ) {
    throw new Error(
      `Incompatible Regie field ${fieldPath}: expected ${expectedField.type} nullable=${expectedField.isNullable}, received ${actualField.type} nullable=${actualField.isNullable}`,
    );
  }

  if (
    expectedField.type === FieldMetadataType.SELECT ||
    expectedField.type === FieldMetadataType.MULTI_SELECT
  ) {
    const actualValues = actualField.options?.map(({ value }) => value) ?? [];
    const expectedValues =
      expectedField.options?.map(({ value }) => value) ?? [];

    if (JSON.stringify(actualValues) !== JSON.stringify(expectedValues)) {
      throw new Error(
        `Incompatible Regie select options for ${fieldPath}: expected ${JSON.stringify(expectedValues)}, received ${JSON.stringify(actualValues)}`,
      );
    }
  }

  if (!isMorphOrRelationFlatFieldMetadata(expectedField)) {
    return;
  }

  if (!isMorphOrRelationFlatFieldMetadata(actualField)) {
    throw new Error(`Incompatible Regie relation ${fieldPath}: not a relation`);
  }

  const actualTargetObject = getObjectById({
    allFlatEntityMaps: actualAllFlatEntityMaps,
    objectMetadataId: actualField.relationTargetObjectMetadataId,
  });
  const expectedTargetObject = getObjectById({
    allFlatEntityMaps: expectedAllFlatEntityMaps,
    objectMetadataId: expectedField.relationTargetObjectMetadataId,
  });
  const actualTargetField = values(
    actualAllFlatEntityMaps.flatFieldMetadataMaps.byUniversalIdentifier,
  ).find(({ id }) => id === actualField.relationTargetFieldMetadataId);
  const expectedTargetField = values(
    expectedAllFlatEntityMaps.flatFieldMetadataMaps.byUniversalIdentifier,
  ).find(({ id }) => id === expectedField.relationTargetFieldMetadataId);
  const actualSettings = actualField.settings;
  const expectedSettings = expectedField.settings;

  if (
    actualTargetObject.nameSingular !== expectedTargetObject.nameSingular ||
    actualTargetField?.name !== expectedTargetField?.name ||
    actualSettings?.relationType !== expectedSettings?.relationType ||
    (expectedSettings?.relationType === RelationType.MANY_TO_ONE &&
      (actualSettings?.onDelete !== expectedSettings.onDelete ||
        actualSettings.joinColumnName !== expectedSettings.joinColumnName))
  ) {
    throw new Error(
      `Incompatible Regie relation ${fieldPath}: expected ${expectedSettings?.relationType} to ${expectedTargetObject.nameSingular}.${expectedTargetField?.name} onDelete=${expectedSettings?.onDelete}, received ${actualSettings?.relationType} to ${actualTargetObject.nameSingular}.${actualTargetField?.name} onDelete=${actualSettings?.onDelete}`,
    );
  }
};

const findCompatibleIndexOrThrow = ({
  expectedIndex,
  actualObject,
  actualFieldsByExpectedUniversalIdentifier,
  actualAllFlatEntityMaps,
}: {
  expectedIndex: FlatIndexMetadata;
  actualObject: FlatObjectMetadata;
  actualFieldsByExpectedUniversalIdentifier: Map<string, FlatFieldMetadata>;
  actualAllFlatEntityMaps: RegieFlatEntityMaps;
}): FlatIndexMetadata => {
  const expectedFieldIds = expectedIndex.universalFlatIndexFieldMetadatas.map(
    ({ fieldMetadataUniversalIdentifier }) =>
      actualFieldsByExpectedUniversalIdentifier.get(
        fieldMetadataUniversalIdentifier,
      )?.id,
  );
  const matchingIndexes = values(
    actualAllFlatEntityMaps.flatIndexMaps.byUniversalIdentifier,
  ).filter(
    (index) =>
      index.objectMetadataId === actualObject.id &&
      index.isUnique === expectedIndex.isUnique &&
      index.indexType === expectedIndex.indexType &&
      index.indexWhereClause === expectedIndex.indexWhereClause &&
      JSON.stringify(
        [...index.flatIndexFieldMetadatas]
          .sort((left, right) => left.order - right.order)
          .map(({ fieldMetadataId }) => fieldMetadataId),
      ) === JSON.stringify(expectedFieldIds),
  );

  if (matchingIndexes.length !== 1) {
    throw new Error(
      `Incompatible Regie index on ${actualObject.nameSingular} for fields ${expectedIndex.universalFlatIndexFieldMetadatas.map(({ fieldMetadataUniversalIdentifier }) => fieldMetadataUniversalIdentifier).join(',')}: expected exactly one compatible index, received ${matchingIndexes.length}`,
    );
  }

  return matchingIndexes[0];
};

@RegisteredWorkspaceCommand('2.32.0', 1786900000000)
@Command({
  name: 'upgrade:2-32:adopt-regie-list-sync-standard-schema',
  description:
    'Create or adopt the Regie Lists v2 and Sync Source v1 standard workspace schema',
})
export class AdoptRegieListSyncStandardSchemaCommand extends ProvisionedWorkspaceCommandRunner {
  constructor(
    protected readonly workspaceIteratorService: WorkspaceIteratorService,
    private readonly applicationService: ApplicationService,
    private readonly workspaceCacheService: WorkspaceCacheService,
    private readonly workspaceMigrationValidateBuildAndRunService: WorkspaceMigrationValidateBuildAndRunService,
  ) {
    super(workspaceIteratorService);
  }

  override async runOnWorkspace({
    workspaceId,
    options,
  }: RunOnWorkspaceArgs): Promise<void> {
    const dryRun = options.dryRun ?? false;
    const { twentyStandardFlatApplication } =
      await this.applicationService.findWorkspaceTwentyStandardAndCustomApplicationOrThrow(
        { workspaceId },
      );
    const actualAllFlatEntityMaps =
      (await this.workspaceCacheService.getOrRecompute(workspaceId, [
        'flatObjectMetadataMaps',
        'flatFieldMetadataMaps',
        'flatIndexMaps',
      ])) as RegieFlatEntityMaps;
    const { allFlatEntityMaps: expectedAllFlatEntityMaps } =
      computeTwentyStandardApplicationAllFlatEntityMaps({
        now: new Date().toISOString(),
        workspaceId,
        twentyStandardApplicationId: twentyStandardFlatApplication.id,
      });
    const allActualObjects = values(
      actualAllFlatEntityMaps.flatObjectMetadataMaps.byUniversalIdentifier,
    );
    const actualObjectsByName = new Map<string, FlatObjectMetadata>();
    let existingRegieObjectCount = 0;

    for (const objectName of REGIE_OBJECT_NAMES) {
      const matches = allActualObjects.filter(
        ({ nameSingular }) => nameSingular === objectName,
      );

      if (matches.length > 1) {
        throw new Error(
          `Duplicate Regie object ${objectName}: found ${matches.length} active metadata rows`,
        );
      }

      if (matches.length === 1) {
        existingRegieObjectCount += 1;
        actualObjectsByName.set(objectName, matches[0]);
      }
    }

    if (existingRegieObjectCount === 0) {
      // Some legacy provisioned workspaces intentionally have no core object
      // graph. A complete Regie relation graph cannot be created there; the
      // standard-application synchronizer can do so if the core graph is later
      // provisioned.
      const hasAllRelationPrerequisites =
        REGIE_RELATION_PREREQUISITE_OBJECT_NAMES.every((objectName) =>
          isDefined(
            actualAllFlatEntityMaps.flatObjectMetadataMaps
              .byUniversalIdentifier[
              STANDARD_OBJECTS[objectName].universalIdentifier
            ],
          ),
        );

      if (!hasAllRelationPrerequisites) {
        return;
      }

      await this.createSchema({
        workspaceId,
        dryRun,
        twentyStandardApplicationUniversalIdentifier:
          twentyStandardFlatApplication.universalIdentifier,
        expectedAllFlatEntityMaps,
      });

      return;
    }

    if (existingRegieObjectCount !== REGIE_OBJECT_NAMES.length) {
      throw new Error(
        `Partial Regie schema in workspace ${workspaceId}: found ${existingRegieObjectCount} of ${REGIE_OBJECT_NAMES.length} required objects`,
      );
    }

    await this.adoptCompatibleSchema({
      workspaceId,
      dryRun,
      twentyStandardApplicationId: twentyStandardFlatApplication.id,
      twentyStandardApplicationUniversalIdentifier:
        twentyStandardFlatApplication.universalIdentifier,
      actualObjectsByName,
      actualAllFlatEntityMaps,
      expectedAllFlatEntityMaps,
    });
  }

  private async createSchema({
    workspaceId,
    dryRun,
    twentyStandardApplicationUniversalIdentifier,
    expectedAllFlatEntityMaps,
  }: {
    workspaceId: string;
    dryRun: boolean;
    twentyStandardApplicationUniversalIdentifier: string;
    expectedAllFlatEntityMaps: RegieFlatEntityMaps;
  }): Promise<void> {
    const objectsToCreate = values(
      expectedAllFlatEntityMaps.flatObjectMetadataMaps.byUniversalIdentifier,
    ).filter(({ universalIdentifier }) =>
      REGIE_OBJECT_UNIVERSAL_IDENTIFIERS.has(universalIdentifier),
    );
    const relevantObjectIds = new Set(objectsToCreate.map(({ id }) => id));
    const fieldsToCreate = values(
      expectedAllFlatEntityMaps.flatFieldMetadataMaps.byUniversalIdentifier,
    ).filter((field) => {
      const object = getObjectById({
        allFlatEntityMaps: expectedAllFlatEntityMaps,
        objectMetadataId: field.objectMetadataId,
      });

      return (
        !field.isSystemSideEffect &&
        (relevantObjectIds.has(field.objectMetadataId) ||
          REGIE_INVERSE_FIELDS.has(`${object.nameSingular}.${field.name}`))
      );
    });
    const indexesToCreate = values(
      expectedAllFlatEntityMaps.flatIndexMaps.byUniversalIdentifier,
    ).filter(({ objectMetadataId }) => relevantObjectIds.has(objectMetadataId));
    const result =
      await this.workspaceMigrationValidateBuildAndRunService.validateBuildAndRunTwentyStandardWorkspaceMigration(
        {
          workspaceId,
          dryRun,
          applicationUniversalIdentifier:
            twentyStandardApplicationUniversalIdentifier,
          allFlatEntityOperationByMetadataName: {
            objectMetadata: {
              flatEntityToCreate: objectsToCreate,
              flatEntityToDelete: [],
              flatEntityToUpdate: [],
            },
            fieldMetadata: {
              flatEntityToCreate: fieldsToCreate,
              flatEntityToDelete: [],
              flatEntityToUpdate: [],
            },
            index: {
              flatEntityToCreate: indexesToCreate,
              flatEntityToDelete: [],
              flatEntityToUpdate: [],
            },
          },
        },
      );

    if (result.status === 'fail') {
      throw new Error(
        `Failed to create Regie standard schema in workspace ${workspaceId}: ${JSON.stringify(result)}`,
      );
    }
  }

  private async adoptCompatibleSchema({
    workspaceId,
    dryRun,
    twentyStandardApplicationId,
    twentyStandardApplicationUniversalIdentifier,
    actualObjectsByName,
    actualAllFlatEntityMaps,
    expectedAllFlatEntityMaps,
  }: {
    workspaceId: string;
    dryRun: boolean;
    twentyStandardApplicationId: string;
    twentyStandardApplicationUniversalIdentifier: string;
    actualObjectsByName: Map<string, FlatObjectMetadata>;
    actualAllFlatEntityMaps: RegieFlatEntityMaps;
    expectedAllFlatEntityMaps: RegieFlatEntityMaps;
  }): Promise<void> {
    const identityReassignments: WorkspaceMigrationIdentityReassignment[] = [];
    const actualFieldsByExpectedUniversalIdentifier = new Map<
      string,
      FlatFieldMetadata
    >();

    for (const objectName of REGIE_OBJECT_NAMES) {
      const actualObject = actualObjectsByName.get(objectName);
      const expectedObject =
        expectedAllFlatEntityMaps.flatObjectMetadataMaps.byUniversalIdentifier[
          STANDARD_OBJECTS[objectName].universalIdentifier
        ];

      if (!isDefined(actualObject) || !isDefined(expectedObject)) {
        throw new Error(`Missing Regie object ${objectName}`);
      }

      if (actualObject.namePlural !== expectedObject.namePlural) {
        throw new Error(
          `Incompatible Regie object ${objectName}: expected plural ${expectedObject.namePlural}, received ${actualObject.namePlural}`,
        );
      }

      identityReassignments.push({
        metadataName: 'objectMetadata',
        sourceUniversalIdentifier: actualObject.universalIdentifier,
        targetUniversalIdentifier: expectedObject.universalIdentifier,
      });
    }

    const expectedFields = values(
      expectedAllFlatEntityMaps.flatFieldMetadataMaps.byUniversalIdentifier,
    ).filter((field) => {
      const object = getObjectById({
        allFlatEntityMaps: expectedAllFlatEntityMaps,
        objectMetadataId: field.objectMetadataId,
      });

      return (
        REGIE_OBJECT_UNIVERSAL_IDENTIFIERS.has(object.universalIdentifier) ||
        REGIE_INVERSE_FIELDS.has(`${object.nameSingular}.${field.name}`)
      );
    });

    for (const expectedField of expectedFields) {
      const expectedObject = getObjectById({
        allFlatEntityMaps: expectedAllFlatEntityMaps,
        objectMetadataId: expectedField.objectMetadataId,
      });
      const actualObject =
        actualObjectsByName.get(expectedObject.nameSingular) ??
        allActualObjectByNameOrThrow({
          allFlatEntityMaps: actualAllFlatEntityMaps,
          objectName: expectedObject.nameSingular,
        });
      const matches = getObjectFields({
        allFlatEntityMaps: actualAllFlatEntityMaps,
        objectMetadataId: actualObject.id,
      }).filter(({ name }) => name === expectedField.name);

      if (matches.length !== 1) {
        throw new Error(
          `Incompatible Regie field ${expectedObject.nameSingular}.${expectedField.name}: expected exactly one active field, received ${matches.length}`,
        );
      }

      const actualField = matches[0];

      assertCompatibleField({
        actualField,
        expectedField,
        actualAllFlatEntityMaps,
        expectedAllFlatEntityMaps,
      });
      actualFieldsByExpectedUniversalIdentifier.set(
        expectedField.universalIdentifier,
        actualField,
      );
      identityReassignments.push({
        metadataName: 'fieldMetadata',
        sourceUniversalIdentifier: actualField.universalIdentifier,
        targetUniversalIdentifier: expectedField.universalIdentifier,
      });
    }

    const expectedIndexes = values(
      expectedAllFlatEntityMaps.flatIndexMaps.byUniversalIdentifier,
    ).filter(({ objectMetadataId }) => {
      const object = getObjectById({
        allFlatEntityMaps: expectedAllFlatEntityMaps,
        objectMetadataId,
      });

      return REGIE_OBJECT_UNIVERSAL_IDENTIFIERS.has(object.universalIdentifier);
    });

    for (const expectedIndex of expectedIndexes) {
      const expectedObject = getObjectById({
        allFlatEntityMaps: expectedAllFlatEntityMaps,
        objectMetadataId: expectedIndex.objectMetadataId,
      });
      const actualObject = actualObjectsByName.get(expectedObject.nameSingular);

      if (!isDefined(actualObject)) {
        throw new Error(`Missing Regie object ${expectedObject.nameSingular}`);
      }

      const actualIndex = findCompatibleIndexOrThrow({
        expectedIndex,
        actualObject,
        actualFieldsByExpectedUniversalIdentifier,
        actualAllFlatEntityMaps,
      });

      identityReassignments.push({
        metadataName: 'index',
        sourceUniversalIdentifier: actualIndex.universalIdentifier,
        targetUniversalIdentifier: expectedIndex.universalIdentifier,
      });
    }

    const needsIdentityReassignment = identityReassignments.some(
      ({
        metadataName,
        sourceUniversalIdentifier,
        targetUniversalIdentifier,
      }) => {
        const maps =
          metadataName === 'objectMetadata'
            ? actualAllFlatEntityMaps.flatObjectMetadataMaps
            : metadataName === 'fieldMetadata'
              ? actualAllFlatEntityMaps.flatFieldMetadataMaps
              : actualAllFlatEntityMaps.flatIndexMaps;
        const entity = maps.byUniversalIdentifier[sourceUniversalIdentifier];

        return (
          sourceUniversalIdentifier !== targetUniversalIdentifier ||
          entity?.applicationId !== twentyStandardApplicationId
        );
      },
    );
    const needsObjectLock = REGIE_OBJECT_NAMES.some((objectName) => {
      const actualObject = actualObjectsByName.get(objectName);
      const expectedObject =
        expectedAllFlatEntityMaps.flatObjectMetadataMaps.byUniversalIdentifier[
          STANDARD_OBJECTS[objectName].universalIdentifier
        ];

      return (
        actualObject?.isUICreatable !== expectedObject?.isUICreatable ||
        actualObject?.isUIEditable !== expectedObject?.isUIEditable ||
        actualObject?.writability !== expectedObject?.writability
      );
    });

    if (!needsIdentityReassignment && !needsObjectLock) {
      return;
    }

    if (needsIdentityReassignment) {
      await this.workspaceMigrationValidateBuildAndRunService.validateAndRunWorkspaceMigrationIdentityReassignment(
        {
          workspaceId,
          dryRun,
          applicationUniversalIdentifier:
            twentyStandardApplicationUniversalIdentifier,
          identityReassignments,
        },
      );
    }

    if (dryRun) {
      return;
    }

    const adoptedObjectsToUpdate = REGIE_OBJECT_NAMES.map((objectName) => {
      const actualObject = actualObjectsByName.get(objectName);
      const expectedObject =
        expectedAllFlatEntityMaps.flatObjectMetadataMaps.byUniversalIdentifier[
          STANDARD_OBJECTS[objectName].universalIdentifier
        ];

      if (!isDefined(actualObject) || !isDefined(expectedObject)) {
        throw new Error(`Missing Regie object ${objectName}`);
      }

      return {
        ...actualObject,
        applicationId: twentyStandardApplicationId,
        applicationUniversalIdentifier:
          twentyStandardApplicationUniversalIdentifier,
        universalIdentifier: expectedObject.universalIdentifier,
        labelIdentifierFieldMetadataUniversalIdentifier:
          expectedObject.labelIdentifierFieldMetadataUniversalIdentifier,
        isUICreatable: expectedObject.isUICreatable,
        isUIEditable: expectedObject.isUIEditable,
        writability: expectedObject.writability,
      };
    });
    const updateResult =
      await this.workspaceMigrationValidateBuildAndRunService.validateBuildAndRunWorkspaceMigration(
        {
          workspaceId,
          isSystemBuild: true,
          applicationUniversalIdentifier:
            twentyStandardApplicationUniversalIdentifier,
          allFlatEntityOperationByMetadataName: {
            objectMetadata: {
              flatEntityToCreate: [],
              flatEntityToDelete: [],
              flatEntityToUpdate: adoptedObjectsToUpdate,
            },
          },
        },
      );

    if (updateResult.status === 'fail') {
      throw new Error(
        `Failed to lock adopted Regie schema in workspace ${workspaceId}: ${JSON.stringify(updateResult)}`,
      );
    }
  }
}

const allActualObjectByNameOrThrow = ({
  allFlatEntityMaps,
  objectName,
}: {
  allFlatEntityMaps: RegieFlatEntityMaps;
  objectName: string;
}): FlatObjectMetadata => {
  const matches = values(
    allFlatEntityMaps.flatObjectMetadataMaps.byUniversalIdentifier,
  ).filter(({ nameSingular }) => nameSingular === objectName);

  if (matches.length !== 1) {
    throw new Error(
      `Incompatible relation target object ${objectName}: expected exactly one active object, received ${matches.length}`,
    );
  }

  return matches[0];
};
