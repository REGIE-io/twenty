import { type AllowedAddressSubField } from '@/types/AddressFieldsType';
import { type FieldMetadataMultiItemSettings } from '@/types/FieldMetadataMultiItemSettings';
import { type FieldMetadataType } from '@/types/FieldMetadataType';
import { type IsExactly } from '@/types/IsExactly';
import { type RelationOnDeleteAction } from '@/types/RelationOnDeleteAction.type';
import { type RelationType } from '@/types/RelationType';
import { type SerializedRelation } from '@/types/SerializedRelation.type';
import { type RegieCustomFieldSettings } from './RegieCustomFieldMarker';

export enum NumberDataType {
  FLOAT = 'float',
  INT = 'int',
  BIGINT = 'bigint',
}

export enum DateDisplayFormat {
  RELATIVE = 'RELATIVE',
  USER_SETTINGS = 'USER_SETTINGS',
  CUSTOM = 'CUSTOM',
}

export type FieldNumberVariant = 'number' | 'percentage';

export type FieldCurrencyFormat = 'short' | 'full';

type FieldMetadataNumberSettings = {
  dataType?: NumberDataType;
  decimals?: number;
  type?: FieldNumberVariant;
};

type FieldMetadataCurrencySettings = {
  format?: FieldCurrencyFormat;
  decimals?: number;
};

type FieldMetadataTextSettings = {
  displayedMaxRows?: number;
};

type FieldMetadataDateSettings = {
  displayFormat?: DateDisplayFormat;
};

type FieldMetadataDateTimeSettings = {
  displayFormat?: DateDisplayFormat;
};

type FieldMetadataRelationSettings = {
  relationType: RelationType;
  onDelete?: RelationOnDeleteAction;
  joinColumnName?: string | null;
  // Points to the target field on the junction object
  // For MORPH_RELATION fields, morphRelations already contains all targets
  junctionTargetFieldId?: SerializedRelation;
};

type FieldMetadataAddressSettings = {
  subFields?: AllowedAddressSubField[];
};

type FieldMetadataFilesSettings = {
  maxNumberOfValues: number;
};

export type FieldMetadataSettingsMapping = {
  [FieldMetadataType.NUMBER]: FieldMetadataNumberSettings | null;
  [FieldMetadataType.CURRENCY]: FieldMetadataCurrencySettings | null;
  [FieldMetadataType.DATE]: FieldMetadataDateSettings | null;
  [FieldMetadataType.DATE_TIME]: FieldMetadataDateTimeSettings | null;
  [FieldMetadataType.TEXT]:
    | (FieldMetadataTextSettings & RegieCustomFieldSettings)
    | null;
  [FieldMetadataType.RELATION]: FieldMetadataRelationSettings;
  [FieldMetadataType.ADDRESS]: FieldMetadataAddressSettings | null;
  [FieldMetadataType.MORPH_RELATION]: FieldMetadataRelationSettings;
  [FieldMetadataType.TS_VECTOR]: null;
  [FieldMetadataType.PHONES]:
    | (FieldMetadataMultiItemSettings & RegieCustomFieldSettings)
    | null;
  [FieldMetadataType.EMAILS]:
    | (FieldMetadataMultiItemSettings & RegieCustomFieldSettings)
    | null;
  [FieldMetadataType.LINKS]:
    | (FieldMetadataMultiItemSettings & RegieCustomFieldSettings)
    | null;
  // Select settings are otherwise empty, but the namespaced Regie marker has to survive
  // metadata create/update serialization, so these two need a slot to live in.
  [FieldMetadataType.SELECT]: RegieCustomFieldSettings | null;
  [FieldMetadataType.MULTI_SELECT]: RegieCustomFieldSettings | null;
  [FieldMetadataType.ARRAY]: FieldMetadataMultiItemSettings | null;
  [FieldMetadataType.FILES]: FieldMetadataFilesSettings;
};

export type AllFieldMetadataSettings =
  FieldMetadataSettingsMapping[keyof FieldMetadataSettingsMapping];

export type FieldMetadataSettings<
  T extends FieldMetadataType = FieldMetadataType,
> =
  IsExactly<T, FieldMetadataType> extends true
    ? null | AllFieldMetadataSettings
    : T extends keyof FieldMetadataSettingsMapping
      ? FieldMetadataSettingsMapping[T]
      : never | null;
