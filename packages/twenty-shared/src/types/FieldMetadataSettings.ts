import { type AllowedAddressSubField } from '@/types/AddressFieldsType';
import { type FieldMetadataMultiItemSettings } from '@/types/FieldMetadataMultiItemSettings';
import { type FieldMetadataType } from '@/types/FieldMetadataType';
import { type IsExactly } from '@/types/IsExactly';
import { type RelationOnDeleteAction } from '@/types/RelationOnDeleteAction.type';
import { type RelationType } from '@/types/RelationType';
import { type SerializedRelation } from '@/types/SerializedRelation.type';
import { z } from 'zod';

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
  [FieldMetadataType.TEXT]: FieldMetadataTextSettings | null;
  [FieldMetadataType.RELATION]: FieldMetadataRelationSettings;
  [FieldMetadataType.ADDRESS]: FieldMetadataAddressSettings | null;
  [FieldMetadataType.MORPH_RELATION]: FieldMetadataRelationSettings;
  [FieldMetadataType.TS_VECTOR]: null;
  [FieldMetadataType.PHONES]: FieldMetadataMultiItemSettings | null;
  [FieldMetadataType.EMAILS]: FieldMetadataMultiItemSettings | null;
  [FieldMetadataType.LINKS]: FieldMetadataMultiItemSettings | null;
  [FieldMetadataType.ARRAY]: FieldMetadataMultiItemSettings | null;
  [FieldMetadataType.FILES]: FieldMetadataFilesSettings;
  // Select settings are otherwise empty, but must preserve the namespaced
  // Regie marker through metadata create/update serialization.
  [FieldMetadataType.SELECT]: RegieCustomFieldSettings | null;
  [FieldMetadataType.MULTI_SELECT]: RegieCustomFieldSettings | null;
};

/** Strict, versioned cross-repository JSON wire contract. */
export const regieCustomFieldMarkerSchema = z
  .object({
    version: z.literal(1),
    target: z.enum(['person', 'account', 'task', 'calendar_event']),
    format: z.enum(['plain', 'percent', 'external_id']),
    searchable: z.boolean(),
  })
  .strict();

export type RegieCustomFieldMarker = z.infer<
  typeof regieCustomFieldMarkerSchema
>;

export type RegieCustomFieldMarkerParseResult =
  | { status: 'absent' }
  | { status: 'valid'; marker: RegieCustomFieldMarker }
  | { status: 'invalid'; issues: string[] };

export const parseRegieCustomFieldMarker = (
  settings: unknown,
): RegieCustomFieldMarkerParseResult => {
  if (
    typeof settings !== 'object' ||
    settings === null ||
    !Object.prototype.hasOwnProperty.call(settings, 'regieCustomField')
  ) {
    return { status: 'absent' };
  }

  const parsed = regieCustomFieldMarkerSchema.safeParse(
    (settings as { regieCustomField: unknown }).regieCustomField,
  );

  return parsed.success
    ? { status: 'valid', marker: parsed.data }
    : {
        status: 'invalid',
        issues: parsed.error.issues.map(
          (issue) =>
            `${issue.path.length === 0 ? 'regieCustomField' : issue.path.join('.')}: ${issue.message}`,
        ),
      };
};

/** Settings owned by Regie and stored in the existing metadata settings JSON. */
export type RegieCustomFieldSettings = {
  regieCustomField?: RegieCustomFieldMarker;
};

type WithRegieCustomFieldSettings<Settings> = Settings extends null
  ? RegieCustomFieldSettings | null
  : Settings & RegieCustomFieldSettings;

export type AllFieldMetadataSettings =
  FieldMetadataSettingsMapping[keyof FieldMetadataSettingsMapping];

export type FieldMetadataSettings<
  T extends FieldMetadataType = FieldMetadataType,
> =
  IsExactly<T, FieldMetadataType> extends true
    ?
        | null
        | (AllFieldMetadataSettings & RegieCustomFieldSettings)
        | RegieCustomFieldSettings
    : T extends keyof FieldMetadataSettingsMapping
      ? WithRegieCustomFieldSettings<FieldMetadataSettingsMapping[T]>
      : RegieCustomFieldSettings | null;
