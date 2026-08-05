import {
  type Equal,
  type Expect,
  type HasAllProperties,
} from 'twenty-shared/testing';
import {
  type FieldNumberVariant,
  type FieldMetadataType,
  type NullablePartial,
  type NumberDataType,
  type RegieCustomFieldMarker,
  type RelationOnDeleteAction,
  type RelationType,
  type SerializedRelation,
} from 'twenty-shared/types';

import { type UniversalFlatFieldMetadata } from 'src/engine/workspace-manager/workspace-migration/universal-flat-entity/types/universal-flat-field-metadata.type';

// Relation field types have defined relation universal identifiers
type DefinedRelationUniversalIdentifierRecord = {
  relationTargetFieldMetadataUniversalIdentifier: string;
  relationTargetObjectMetadataUniversalIdentifier: string;
};

// Non-relation field types have never | null relation universal identifiers
type NotDefinedRelationUniversalIdentifierRecord = {
  relationTargetFieldMetadataUniversalIdentifier: never | null;
  relationTargetObjectMetadataUniversalIdentifier: never | null;
};

// Date properties are cast to strings
type DatePropertiesCastToString = {
  createdAt: string;
  updatedAt: string;
};

// OneToMany relations become ...UniversalIdentifiers arrays
type OneToManyUniversalIdentifierArrays = {
  viewFieldUniversalIdentifiers: string[];
  viewFilterUniversalIdentifiers: string[];
  kanbanAggregateOperationViewUniversalIdentifiers: string[];
  calendarViewUniversalIdentifiers: string[];
  calendarEndViewUniversalIdentifiers: string[];
  mainGroupByFieldMetadataViewUniversalIdentifiers: string[];
};

// Narrowed relation universal identifier assertions - verifies conditional typing is preserved
// oxlint-disable-next-line unused-imports/no-unused-vars
type RelationUniversalIdentifierAssertions = [
  // Non-relation types have undefined relation universal identifiers
  Expect<
    HasAllProperties<
      UniversalFlatFieldMetadata<FieldMetadataType.UUID>,
      NotDefinedRelationUniversalIdentifierRecord
    >
  >,

  // Relation types have defined relation universal identifiers
  Expect<
    HasAllProperties<
      UniversalFlatFieldMetadata<FieldMetadataType.RELATION>,
      DefinedRelationUniversalIdentifierRecord
    >
  >,
  Expect<
    HasAllProperties<
      UniversalFlatFieldMetadata<FieldMetadataType.MORPH_RELATION>,
      DefinedRelationUniversalIdentifierRecord
    >
  >,

  // Abstract type has nullable partial relation universal identifiers
  Expect<
    HasAllProperties<
      UniversalFlatFieldMetadata,
      NullablePartial<DefinedRelationUniversalIdentifierRecord>
    >
  >,
];

// oxlint-disable-next-line unused-imports/no-unused-vars
type UniversalFlatTransformationAssertions = [
  Expect<
    HasAllProperties<UniversalFlatFieldMetadata, DatePropertiesCastToString>
  >,
  Expect<
    HasAllProperties<
      UniversalFlatFieldMetadata,
      OneToManyUniversalIdentifierArrays
    >
  >,
];

// The Regie namespace extends, rather than replaces, the existing universal
// settings contract. Check both halves independently so the marker does not
// weaken the relation/number/text transformation guarantees.
type WithoutRegieMarker<T> = T extends object ? Omit<T, 'regieCustomField'> : T;

type RegieMarkerOf<T> = T extends { regieCustomField?: infer Marker }
  ? Marker
  : never;

type NarrowedSettingsTestCase =
  UniversalFlatFieldMetadata<FieldMetadataType.RELATION>['universalSettings'];

type NarrowedSettingsExpectedResult = {
  relationType: RelationType;
  onDelete?: RelationOnDeleteAction | undefined;
  joinColumnName?: string | null | undefined;
  junctionTargetFieldUniversalIdentifier?:
    | SerializedRelation
    | null
    | undefined;
  __JsonbPropertyBrand__?: undefined;
};

type SettingsTestCase = UniversalFlatFieldMetadata<
  FieldMetadataType.RELATION | FieldMetadataType.NUMBER | FieldMetadataType.TEXT
>['universalSettings'];

type SettingsExpectedResult =
  | NarrowedSettingsExpectedResult
  | {
      dataType?: NumberDataType | undefined;
      decimals?: number | undefined;
      type?: FieldNumberVariant | undefined;
      __JsonbPropertyBrand__?: undefined;
    }
  | {
      displayedMaxRows?: number | undefined;
      __JsonbPropertyBrand__?: undefined;
    }
  | null;

// oxlint-disable-next-line unused-imports/no-unused-vars
type UniversalSettingsAssertions = [
  Expect<
    Equal<
      WithoutRegieMarker<NarrowedSettingsTestCase>,
      NarrowedSettingsExpectedResult
    >
  >,
  Expect<Equal<WithoutRegieMarker<SettingsTestCase>, SettingsExpectedResult>>,
  Expect<
    Equal<
      RegieMarkerOf<Exclude<NarrowedSettingsTestCase, null>>,
      RegieCustomFieldMarker | undefined
    >
  >,
  Expect<
    Equal<
      RegieMarkerOf<Exclude<SettingsTestCase, null>>,
      RegieCustomFieldMarker | undefined
    >
  >,
];
