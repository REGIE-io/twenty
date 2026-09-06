import {
  getSelectOptionUniversalIdentifier,
  TWENTY_STANDARD_APPLICATION_UNIVERSAL_IDENTIFIER,
} from 'twenty-shared/application';
import { STANDARD_OBJECTS } from 'twenty-shared/metadata';
import {
  DateDisplayFormat,
  FieldMetadataType,
  type FieldMetadataDefaultOption,
} from 'twenty-shared/types';

import { type FlatFieldMetadata } from 'src/engine/metadata-modules/flat-field-metadata/types/flat-field-metadata.type';
import { type AllStandardObjectFieldName } from 'src/engine/workspace-manager/twenty-standard-application/types/all-standard-object-field-name.type';
import { type AllStandardObjectName } from 'src/engine/workspace-manager/twenty-standard-application/types/all-standard-object-name.type';
import {
  type CreateStandardFieldArgs,
  createStandardFieldFlatMetadata,
} from 'src/engine/workspace-manager/twenty-standard-application/utils/field-metadata/create-standard-field-flat-metadata.util';

type RegieStandardObjectName =
  | 'regieStaticList'
  | 'regieListMembership'
  | 'regieSyncSource';

type RegieFieldBuilderArgs<O extends RegieStandardObjectName> = Omit<
  CreateStandardFieldArgs<O, FieldMetadataType>,
  'context'
>;

type SystemFieldName =
  | 'id'
  | 'createdAt'
  | 'updatedAt'
  | 'deletedAt'
  | 'createdBy'
  | 'updatedBy'
  | 'position'
  | 'searchVector';

const createRegieField = <O extends RegieStandardObjectName>(
  args: RegieFieldBuilderArgs<O>,
  context: CreateStandardFieldArgs<O, FieldMetadataType>['context'],
): FlatFieldMetadata =>
  createStandardFieldFlatMetadata({
    ...args,
    context,
  });

export const buildRegieStandardSystemFields = <
  O extends RegieStandardObjectName,
>(
  args: RegieFieldBuilderArgs<O>,
): Record<SystemFieldName, FlatFieldMetadata> => ({
  id: createRegieField(args, {
    fieldName: 'id',
    type: FieldMetadataType.UUID,
    label: 'Id',
    description: 'Record identifier',
    icon: 'Icon123',
    isSystem: true,
    isNullable: false,
    isUIEditable: false,
    defaultValue: 'uuid',
  }),
  createdAt: createRegieField(args, {
    fieldName: 'createdAt',
    type: FieldMetadataType.DATE_TIME,
    label: 'Creation date',
    description: 'Date the record was created',
    icon: 'IconCalendar',
    isSystem: true,
    isNullable: false,
    isUIEditable: false,
    defaultValue: 'now',
    settings: { displayFormat: DateDisplayFormat.RELATIVE },
  }),
  updatedAt: createRegieField(args, {
    fieldName: 'updatedAt',
    type: FieldMetadataType.DATE_TIME,
    label: 'Last update',
    description: 'Date the record was last updated',
    icon: 'IconCalendarClock',
    isSystem: true,
    isNullable: false,
    isUIEditable: false,
    defaultValue: 'now',
    settings: { displayFormat: DateDisplayFormat.RELATIVE },
  }),
  deletedAt: createRegieField(args, {
    fieldName: 'deletedAt',
    type: FieldMetadataType.DATE_TIME,
    label: 'Deleted at',
    description: 'Date the record was deleted',
    icon: 'IconCalendarMinus',
    isSystem: true,
    isNullable: true,
    isUIEditable: false,
    settings: { displayFormat: DateDisplayFormat.RELATIVE },
  }),
  createdBy: createRegieField(args, {
    fieldName: 'createdBy',
    type: FieldMetadataType.ACTOR,
    label: 'Created by',
    description: 'The creator of the record',
    icon: 'IconCreativeCommonsSa',
    isSystem: true,
    isUIEditable: false,
    isNullable: false,
    defaultValue: {
      source: "'MANUAL'",
      name: "'System'",
      workspaceMemberId: null,
    },
  }),
  updatedBy: createRegieField(args, {
    fieldName: 'updatedBy',
    type: FieldMetadataType.ACTOR,
    label: 'Updated by',
    description: 'The workspace member who last updated the record',
    icon: 'IconUserCircle',
    isSystem: true,
    isUIEditable: false,
    isNullable: false,
    defaultValue: {
      source: "'MANUAL'",
      name: "'System'",
      workspaceMemberId: null,
    },
  }),
  position: createRegieField(args, {
    fieldName: 'position',
    type: FieldMetadataType.POSITION,
    label: 'Position',
    description: 'Record position',
    icon: 'IconHierarchy2',
    isSystem: true,
    isNullable: false,
    defaultValue: 0,
  }),
  searchVector: createRegieField(args, {
    fieldName: 'searchVector',
    type: FieldMetadataType.TS_VECTOR,
    label: 'Search vector',
    description: 'Field used for full-text search',
    icon: 'IconSearch',
    isSystem: true,
    isNullable: true,
  }),
});

export const createRegieStandardScalarField = <
  O extends RegieStandardObjectName,
>({
  args,
  fieldName,
  type,
  label,
  isNullable = true,
  options,
}: {
  args: RegieFieldBuilderArgs<O>;
  fieldName: AllStandardObjectFieldName<O>;
  type: FieldMetadataType;
  label: string;
  isNullable?: boolean;
  options?: readonly string[];
}): FlatFieldMetadata => {
  const fieldUniversalIdentifier =
    STANDARD_OBJECTS[args.objectName].fields[fieldName].universalIdentifier;
  const selectOptions: FieldMetadataDefaultOption[] | null = options
    ? options.map((value, position) => ({
        id: getSelectOptionUniversalIdentifier({
          applicationUniversalIdentifier:
            TWENTY_STANDARD_APPLICATION_UNIVERSAL_IDENTIFIER,
          fieldUniversalIdentifier,
          value,
        }),
        value,
        label: value,
        color: 'gray',
        position,
      }))
    : null;

  return createRegieField(args, {
    fieldName,
    type,
    label,
    description: label,
    icon: 'IconBox',
    isNullable,
    options: selectOptions,
  });
};

export type { RegieFieldBuilderArgs, RegieStandardObjectName };
