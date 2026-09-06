import { STANDARD_OBJECTS } from 'twenty-shared/metadata';
import {
  FieldMetadataType,
  RelationOnDeleteAction,
  RelationType,
} from 'twenty-shared/types';
import { isDefined } from 'twenty-shared/utils';

import { type FlatFieldMetadata } from 'src/engine/metadata-modules/flat-field-metadata/types/flat-field-metadata.type';
import { computeTwentyStandardApplicationAllFlatEntityMaps } from 'src/engine/workspace-manager/twenty-standard-application/utils/twenty-standard-application-all-flat-entity-maps.constant';

const WORKSPACE_ID = '20202020-1111-4111-8111-111111111111';
const APPLICATION_ID = '20202020-2222-4222-8222-222222222222';
const NOW = '2026-09-06T00:00:00.000Z';

const { allFlatEntityMaps } = computeTwentyStandardApplicationAllFlatEntityMaps(
  {
    now: NOW,
    workspaceId: WORKSPACE_ID,
    twentyStandardApplicationId: APPLICATION_ID,
  },
);

const fieldsFor = (objectUniversalIdentifier: string) => {
  const object =
    allFlatEntityMaps.flatObjectMetadataMaps.byUniversalIdentifier[
      objectUniversalIdentifier
    ];

  expect(object).toBeDefined();

  return Object.values(
    allFlatEntityMaps.flatFieldMetadataMaps.byUniversalIdentifier,
  )
    .filter(isDefined)
    .filter(({ objectMetadataId }) => objectMetadataId === object?.id);
};

const fieldByName = (
  objectUniversalIdentifier: string,
  fieldName: string,
): FlatFieldMetadata => {
  const matches = fieldsFor(objectUniversalIdentifier).filter(
    ({ name }) => name === fieldName,
  );

  expect(matches).toHaveLength(1);

  return matches[0];
};

describe('Regie Lists and Sync Source standard metadata build', () => {
  it.each([
    [
      'regieStaticList',
      'regieStaticLists',
      'Regie Static List',
      'Regie Static Lists',
      'name',
    ],
    [
      'regieListMembership',
      'regieListMemberships',
      'Regie List Membership',
      'Regie List Memberships',
      'membershipKey',
    ],
    [
      'regieSyncSource',
      'regieSyncSources',
      'CRM Sync Source',
      'CRM Sync Sources',
      'sourceKey',
    ],
  ] as const)(
    'builds the complete application-owned %s object',
    (nameSingular, namePlural, labelSingular, labelPlural, labelFieldName) => {
      const definition = STANDARD_OBJECTS[nameSingular];
      const object =
        allFlatEntityMaps.flatObjectMetadataMaps.byUniversalIdentifier[
          definition.universalIdentifier
        ];

      expect(object).toMatchObject({
        applicationId: APPLICATION_ID,
        universalIdentifier: definition.universalIdentifier,
        nameSingular,
        namePlural,
        labelSingular,
        labelPlural,
        isSystem: true,
        isUICreatable: false,
        isUIEditable: false,
      });
      expect(object?.labelIdentifierFieldMetadataId).toBe(
        fieldByName(definition.universalIdentifier, labelFieldName).id,
      );
    },
  );

  it.each([
    [
      'regieStaticList',
      {
        name: FieldMetadataType.TEXT,
        targetType: FieldMetadataType.SELECT,
        populationStatus: FieldMetadataType.SELECT,
        sourceType: FieldMetadataType.SELECT,
        sourceRef: FieldMetadataType.TEXT,
        snapshotStartedAt: FieldMetadataType.DATE_TIME,
        snapshotFilter: FieldMetadataType.TEXT,
        sourceFilterRevision: FieldMetadataType.TEXT,
        populationProcessed: FieldMetadataType.NUMBER,
        populationAdded: FieldMetadataType.NUMBER,
        populationSkipped: FieldMetadataType.NUMBER,
        populationFailed: FieldMetadataType.NUMBER,
        members: FieldMetadataType.RELATION,
      },
      21,
    ],
    [
      'regieListMembership',
      {
        membershipKey: FieldMetadataType.TEXT,
        source: FieldMetadataType.SELECT,
        list: FieldMetadataType.RELATION,
        person: FieldMetadataType.RELATION,
        account: FieldMetadataType.RELATION,
        task: FieldMetadataType.RELATION,
      },
      14,
    ],
    [
      'regieSyncSource',
      {
        sourceKey: FieldMetadataType.TEXT,
        syncSystem: FieldMetadataType.SELECT,
        localObjectType: FieldMetadataType.SELECT,
        externalObjectApiName: FieldMetadataType.TEXT,
        externalRecordId: FieldMetadataType.TEXT,
        connectionGeneration: FieldMetadataType.NUMBER,
        lifecycleState: FieldMetadataType.SELECT,
        deliveryState: FieldMetadataType.SELECT,
        isWriteTarget: FieldMetadataType.BOOLEAN,
        lastAttemptAt: FieldMetadataType.DATE_TIME,
        lastSyncedAt: FieldMetadataType.DATE_TIME,
        lastError: FieldMetadataType.TEXT,
        person: FieldMetadataType.RELATION,
        company: FieldMetadataType.RELATION,
        task: FieldMetadataType.RELATION,
      },
      23,
    ],
  ] as const)(
    'builds every %s field with the expected type and nullability',
    (objectName, expectedTypes, expectedCount) => {
      const definition = STANDARD_OBJECTS[objectName];
      const fields = fieldsFor(definition.universalIdentifier);

      expect(fields).toHaveLength(expectedCount);
      for (const [fieldName, type] of Object.entries(expectedTypes)) {
        expect(
          fieldByName(definition.universalIdentifier, fieldName),
        ).toMatchObject({
          type,
          isNullable: true,
          universalIdentifier:
            definition.fields[fieldName as keyof typeof definition.fields]
              .universalIdentifier,
        });
      }
    },
  );

  it.each([
    ['regieStaticList', 'targetType', ['PERSON', 'ACCOUNT', 'TASK']],
    [
      'regieStaticList',
      'populationStatus',
      ['READY', 'POPULATING', 'PARTIAL', 'FAILED'],
    ],
    [
      'regieStaticList',
      'sourceType',
      ['MANUAL', 'DYNAMIC_SNAPSHOT', 'CSV_IMPORT'],
    ],
    ['regieListMembership', 'source', ['MANUAL', 'SNAPSHOT', 'CSV', 'API']],
    ['regieSyncSource', 'syncSystem', ['SALESFORCE', 'HUBSPOT']],
    ['regieSyncSource', 'localObjectType', ['PERSON', 'COMPANY', 'TASK']],
    [
      'regieSyncSource',
      'lifecycleState',
      ['ACTIVE', 'CONVERTED', 'MERGED', 'DELETED'],
    ],
    [
      'regieSyncSource',
      'deliveryState',
      ['SYNCED', 'PENDING', 'CHECKING', 'FAILED', 'PAUSED'],
    ],
  ] as const)(
    'builds deterministic options for %s.%s',
    (objectName, fieldName, optionValues) => {
      const definition = STANDARD_OBJECTS[objectName];
      const field = fieldByName(definition.universalIdentifier, fieldName);
      const secondBuild = computeTwentyStandardApplicationAllFlatEntityMaps({
        now: NOW,
        workspaceId: WORKSPACE_ID,
        twentyStandardApplicationId: APPLICATION_ID,
      }).allFlatEntityMaps.flatFieldMetadataMaps.byUniversalIdentifier[
        field.universalIdentifier
      ];

      expect(field.options?.map(({ value }) => value)).toEqual(optionValues);
      expect(field.options?.map(({ id }) => id)).toEqual(
        secondBuild?.options?.map(({ id }) => id),
      );
      expect(new Set(field.options?.map(({ id }) => id)).size).toBe(
        optionValues.length,
      );
    },
  );

  it.each([
    ['regieListMembership', 'list', 'regieStaticList', 'members', 'listId'],
    [
      'regieListMembership',
      'person',
      'person',
      'regieListMemberships',
      'personId',
    ],
    [
      'regieListMembership',
      'account',
      'company',
      'regieListMemberships',
      'accountId',
    ],
    ['regieListMembership', 'task', 'task', 'regieListMemberships', 'taskId'],
    ['regieSyncSource', 'person', 'person', 'regieSyncSources', 'personId'],
    ['regieSyncSource', 'company', 'company', 'regieSyncSources', 'companyId'],
    ['regieSyncSource', 'task', 'task', 'regieSyncSources', 'taskId'],
  ] as const)(
    'builds %s.%s and its inverse relation',
    (
      sourceObjectName,
      sourceFieldName,
      targetObjectName,
      targetFieldName,
      joinColumnName,
    ) => {
      const source = STANDARD_OBJECTS[sourceObjectName];
      const target = STANDARD_OBJECTS[targetObjectName];
      const sourceField = fieldByName(
        source.universalIdentifier,
        sourceFieldName,
      );
      const targetField = fieldByName(
        target.universalIdentifier,
        targetFieldName,
      );

      expect(sourceField).toMatchObject({
        relationTargetFieldMetadataId: targetField.id,
        relationTargetObjectMetadataId:
          allFlatEntityMaps.flatObjectMetadataMaps.byUniversalIdentifier[
            target.universalIdentifier
          ]?.id,
        settings: {
          relationType: RelationType.MANY_TO_ONE,
          onDelete: RelationOnDeleteAction.CASCADE,
          joinColumnName,
        },
      });
      expect(targetField).toMatchObject({
        relationTargetFieldMetadataId: sourceField.id,
        settings: { relationType: RelationType.ONE_TO_MANY },
      });
    },
  );

  it('builds exactly the three explicit Regie indexes with ordered fields', () => {
    const indexes = Object.values(
      allFlatEntityMaps.flatIndexMaps.byUniversalIdentifier,
    )
      .filter(isDefined)
      .filter(({ objectMetadataUniversalIdentifier }) =>
        [
          STANDARD_OBJECTS.regieStaticList.universalIdentifier,
          STANDARD_OBJECTS.regieListMembership.universalIdentifier,
          STANDARD_OBJECTS.regieSyncSource.universalIdentifier,
        ].includes(objectMetadataUniversalIdentifier),
      );
    const shape = indexes.map((index) => ({
      universalIdentifier: index.universalIdentifier,
      isUnique: index.isUnique,
      fields: [...index.universalFlatIndexFieldMetadatas]
        .sort((left, right) => left.order - right.order)
        .map(
          ({ fieldMetadataUniversalIdentifier }) =>
            Object.entries(
              STANDARD_OBJECTS[
                index.objectMetadataUniversalIdentifier ===
                STANDARD_OBJECTS.regieListMembership.universalIdentifier
                  ? 'regieListMembership'
                  : 'regieSyncSource'
              ].fields,
            ).find(
              ([, field]) =>
                field.universalIdentifier === fieldMetadataUniversalIdentifier,
            )?.[0],
        ),
    }));

    expect(shape).toEqual(
      expect.arrayContaining([
        {
          universalIdentifier:
            STANDARD_OBJECTS.regieListMembership.indexes
              .membershipKeyUniqueIndex.universalIdentifier,
          isUnique: true,
          fields: ['membershipKey'],
        },
        {
          universalIdentifier:
            STANDARD_OBJECTS.regieSyncSource.indexes.sourceKeyUniqueIndex
              .universalIdentifier,
          isUnique: true,
          fields: ['sourceKey'],
        },
        {
          universalIdentifier:
            STANDARD_OBJECTS.regieSyncSource.indexes.externalRecordLookupIndex
              .universalIdentifier,
          isUnique: false,
          fields: ['externalRecordId', 'externalObjectApiName'],
        },
      ]),
    );
    expect(shape).toHaveLength(3);
  });
});
