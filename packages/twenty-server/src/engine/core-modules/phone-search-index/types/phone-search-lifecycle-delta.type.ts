import { type FlatFieldMetadata } from 'src/engine/metadata-modules/flat-field-metadata/types/flat-field-metadata.type';

type PhoneSearchLifecycleFieldProperties =
  | 'id'
  | 'universalIdentifier'
  | 'name'
  | 'isActive'
  | 'type'
  | 'objectMetadataUniversalIdentifier';

export type PhoneSearchLifecycleField = Partial<
  Pick<FlatFieldMetadata, PhoneSearchLifecycleFieldProperties>
>;

export type PhoneSearchLifecycleUpdatedField = PhoneSearchLifecycleField & {
  before?: PhoneSearchLifecycleField;
};

export type PhoneSearchLifecycleDelta = {
  objectMetadataId: string;
  created: PhoneSearchLifecycleField[];
  updated: PhoneSearchLifecycleUpdatedField[];
  deleted: PhoneSearchLifecycleField[];
};
