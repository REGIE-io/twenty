import { STANDARD_OBJECTS } from 'twenty-shared/metadata';
import {
  FieldMetadataType,
  RelationOnDeleteAction,
  RelationType,
} from 'twenty-shared/types';

import { type FlatFieldMetadata } from 'src/engine/metadata-modules/flat-field-metadata/types/flat-field-metadata.type';
import { type AllStandardObjectFieldName } from 'src/engine/workspace-manager/twenty-standard-application/types/all-standard-object-field-name.type';
import {
  buildRegieStandardSystemFields,
  createRegieStandardScalarField,
  type RegieFieldBuilderArgs,
} from 'src/engine/workspace-manager/twenty-standard-application/utils/field-metadata/build-regie-standard-flat-field-metadata.util';
import { createStandardRelationFieldFlatMetadata } from 'src/engine/workspace-manager/twenty-standard-application/utils/field-metadata/create-standard-relation-field-flat-metadata.util';

export const buildRegieStaticListStandardFlatFieldMetadatas = (
  args: RegieFieldBuilderArgs<'regieStaticList'>,
): Record<
  AllStandardObjectFieldName<'regieStaticList'>,
  FlatFieldMetadata
> => ({
  ...buildRegieStandardSystemFields(args),
  name: createRegieStandardScalarField({
    args,
    fieldName: 'name',
    type: FieldMetadataType.TEXT,
    label: 'Name',
  }),
  targetType: createRegieStandardScalarField({
    args,
    fieldName: 'targetType',
    type: FieldMetadataType.SELECT,
    label: 'Target Type',
    options: ['PERSON', 'ACCOUNT', 'TASK'],
  }),
  populationStatus: createRegieStandardScalarField({
    args,
    fieldName: 'populationStatus',
    type: FieldMetadataType.SELECT,
    label: 'Population Status',
    options: ['READY', 'POPULATING', 'PARTIAL', 'FAILED'],
  }),
  sourceType: createRegieStandardScalarField({
    args,
    fieldName: 'sourceType',
    type: FieldMetadataType.SELECT,
    label: 'Source Type',
    options: ['MANUAL', 'DYNAMIC_SNAPSHOT', 'CSV_IMPORT'],
  }),
  sourceRef: createRegieStandardScalarField({
    args,
    fieldName: 'sourceRef',
    type: FieldMetadataType.TEXT,
    label: 'Source Reference',
  }),
  snapshotStartedAt: createRegieStandardScalarField({
    args,
    fieldName: 'snapshotStartedAt',
    type: FieldMetadataType.DATE_TIME,
    label: 'Snapshot Started At',
  }),
  snapshotFilter: createRegieStandardScalarField({
    args,
    fieldName: 'snapshotFilter',
    type: FieldMetadataType.TEXT,
    label: 'Snapshot Filter',
  }),
  sourceFilterRevision: createRegieStandardScalarField({
    args,
    fieldName: 'sourceFilterRevision',
    type: FieldMetadataType.TEXT,
    label: 'Source Filter Revision',
  }),
  populationProcessed: createRegieStandardScalarField({
    args,
    fieldName: 'populationProcessed',
    type: FieldMetadataType.NUMBER,
    label: 'Population Processed',
  }),
  populationAdded: createRegieStandardScalarField({
    args,
    fieldName: 'populationAdded',
    type: FieldMetadataType.NUMBER,
    label: 'Population Added',
  }),
  populationSkipped: createRegieStandardScalarField({
    args,
    fieldName: 'populationSkipped',
    type: FieldMetadataType.NUMBER,
    label: 'Population Skipped',
  }),
  populationFailed: createRegieStandardScalarField({
    args,
    fieldName: 'populationFailed',
    type: FieldMetadataType.NUMBER,
    label: 'Population Failed',
  }),
  members: createStandardRelationFieldFlatMetadata({
    ...args,
    context: {
      type: FieldMetadataType.RELATION,
      morphId: null,
      fieldName: 'members',
      label: 'Members',
      description: 'Records in the list',
      icon: 'IconListDetails',
      targetObjectName: 'regieListMembership',
      targetFieldName: 'list',
      settings: { relationType: RelationType.ONE_TO_MANY },
    },
  }),
});

export const buildRegieListMembershipStandardFlatFieldMetadatas = (
  args: RegieFieldBuilderArgs<'regieListMembership'>,
): Record<
  AllStandardObjectFieldName<'regieListMembership'>,
  FlatFieldMetadata
> => ({
  ...buildRegieStandardSystemFields(args),
  membershipKey: createRegieStandardScalarField({
    args,
    fieldName: 'membershipKey',
    type: FieldMetadataType.TEXT,
    label: 'Membership Key',
  }),
  source: createRegieStandardScalarField({
    args,
    fieldName: 'source',
    type: FieldMetadataType.SELECT,
    label: 'Source',
    options: ['MANUAL', 'SNAPSHOT', 'CSV', 'API'],
  }),
  list: createStandardRelationFieldFlatMetadata({
    ...args,
    context: {
      type: FieldMetadataType.RELATION,
      morphId: null,
      fieldName: 'list',
      label: 'List',
      description: 'The owning Regie list',
      icon: 'IconList',
      targetObjectName: 'regieStaticList',
      targetFieldName: 'members',
      settings: {
        relationType: RelationType.MANY_TO_ONE,
        onDelete: RelationOnDeleteAction.CASCADE,
        joinColumnName: 'listId',
      },
    },
  }),
  person: createStandardRelationFieldFlatMetadata({
    ...args,
    context: {
      type: FieldMetadataType.RELATION,
      morphId: null,
      fieldName: 'person',
      label: 'Person',
      description: 'The person represented by this membership',
      icon: 'IconUser',
      targetObjectName: 'person',
      targetFieldName: 'regieListMemberships',
      settings: {
        relationType: RelationType.MANY_TO_ONE,
        onDelete: RelationOnDeleteAction.CASCADE,
        joinColumnName: 'personId',
      },
    },
  }),
  account: createStandardRelationFieldFlatMetadata({
    ...args,
    context: {
      type: FieldMetadataType.RELATION,
      morphId: null,
      fieldName: 'account',
      label: 'Account',
      description: 'The company represented by this membership',
      icon: 'IconBuildingSkyscraper',
      targetObjectName: 'company',
      targetFieldName: 'regieListMemberships',
      settings: {
        relationType: RelationType.MANY_TO_ONE,
        onDelete: RelationOnDeleteAction.CASCADE,
        joinColumnName: 'accountId',
      },
    },
  }),
  task: createStandardRelationFieldFlatMetadata({
    ...args,
    context: {
      type: FieldMetadataType.RELATION,
      morphId: null,
      fieldName: 'task',
      label: 'Task',
      description: 'The task represented by this membership',
      icon: 'IconCheckbox',
      targetObjectName: 'task',
      targetFieldName: 'regieListMemberships',
      settings: {
        relationType: RelationType.MANY_TO_ONE,
        onDelete: RelationOnDeleteAction.CASCADE,
        joinColumnName: 'taskId',
      },
    },
  }),
});

export const buildRegieSyncSourceStandardFlatFieldMetadatas = (
  args: RegieFieldBuilderArgs<'regieSyncSource'>,
): Record<
  AllStandardObjectFieldName<'regieSyncSource'>,
  FlatFieldMetadata
> => ({
  ...buildRegieStandardSystemFields(args),
  sourceKey: createRegieStandardScalarField({
    args,
    fieldName: 'sourceKey',
    type: FieldMetadataType.TEXT,
    label: 'Source Key',
  }),
  syncSystem: createRegieStandardScalarField({
    args,
    fieldName: 'syncSystem',
    type: FieldMetadataType.SELECT,
    label: 'Sync System',
    options: ['SALESFORCE', 'HUBSPOT'],
  }),
  localObjectType: createRegieStandardScalarField({
    args,
    fieldName: 'localObjectType',
    type: FieldMetadataType.SELECT,
    label: 'Local Object Type',
    options: ['PERSON', 'COMPANY', 'TASK'],
  }),
  externalObjectApiName: createRegieStandardScalarField({
    args,
    fieldName: 'externalObjectApiName',
    type: FieldMetadataType.TEXT,
    label: 'External Object',
  }),
  externalRecordId: createRegieStandardScalarField({
    args,
    fieldName: 'externalRecordId',
    type: FieldMetadataType.TEXT,
    label: 'External Record ID',
  }),
  connectionGeneration: createRegieStandardScalarField({
    args,
    fieldName: 'connectionGeneration',
    type: FieldMetadataType.NUMBER,
    label: 'Connection Generation',
  }),
  lifecycleState: createRegieStandardScalarField({
    args,
    fieldName: 'lifecycleState',
    type: FieldMetadataType.SELECT,
    label: 'Lifecycle',
    options: ['ACTIVE', 'CONVERTED', 'MERGED', 'DELETED'],
  }),
  deliveryState: createRegieStandardScalarField({
    args,
    fieldName: 'deliveryState',
    type: FieldMetadataType.SELECT,
    label: 'Delivery State',
    options: ['SYNCED', 'PENDING', 'CHECKING', 'FAILED', 'PAUSED'],
  }),
  isWriteTarget: createRegieStandardScalarField({
    args,
    fieldName: 'isWriteTarget',
    type: FieldMetadataType.BOOLEAN,
    label: 'Write Target',
  }),
  lastAttemptAt: createRegieStandardScalarField({
    args,
    fieldName: 'lastAttemptAt',
    type: FieldMetadataType.DATE_TIME,
    label: 'Last Attempt At',
  }),
  lastSyncedAt: createRegieStandardScalarField({
    args,
    fieldName: 'lastSyncedAt',
    type: FieldMetadataType.DATE_TIME,
    label: 'Last Synced At',
  }),
  lastError: createRegieStandardScalarField({
    args,
    fieldName: 'lastError',
    type: FieldMetadataType.TEXT,
    label: 'Last Error',
  }),
  person: createStandardRelationFieldFlatMetadata({
    ...args,
    context: {
      type: FieldMetadataType.RELATION,
      morphId: null,
      fieldName: 'person',
      label: 'Person',
      description: 'The local person for this source record',
      icon: 'IconUser',
      targetObjectName: 'person',
      targetFieldName: 'regieSyncSources',
      settings: {
        relationType: RelationType.MANY_TO_ONE,
        onDelete: RelationOnDeleteAction.CASCADE,
        joinColumnName: 'personId',
      },
    },
  }),
  company: createStandardRelationFieldFlatMetadata({
    ...args,
    context: {
      type: FieldMetadataType.RELATION,
      morphId: null,
      fieldName: 'company',
      label: 'Company',
      description: 'The local company for this source record',
      icon: 'IconBuildingSkyscraper',
      targetObjectName: 'company',
      targetFieldName: 'regieSyncSources',
      settings: {
        relationType: RelationType.MANY_TO_ONE,
        onDelete: RelationOnDeleteAction.CASCADE,
        joinColumnName: 'companyId',
      },
    },
  }),
  task: createStandardRelationFieldFlatMetadata({
    ...args,
    context: {
      type: FieldMetadataType.RELATION,
      morphId: null,
      fieldName: 'task',
      label: 'Task',
      description: 'The local task for this source record',
      icon: 'IconCheckbox',
      targetObjectName: 'task',
      targetFieldName: 'regieSyncSources',
      settings: {
        relationType: RelationType.MANY_TO_ONE,
        onDelete: RelationOnDeleteAction.CASCADE,
        joinColumnName: 'taskId',
      },
    },
  }),
});

export const REGIE_STANDARD_OBJECTS = [
  STANDARD_OBJECTS.regieStaticList,
  STANDARD_OBJECTS.regieListMembership,
  STANDARD_OBJECTS.regieSyncSource,
] as const;
