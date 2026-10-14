import { type FieldMetadataType } from 'twenty-shared/types';

import { type IndexType } from 'src/engine/metadata-modules/index-metadata/types/indexType.types';

export type SchemaApplySnapshotField = {
  id: string;
  name: string;
  type: FieldMetadataType;
  settings: Record<string, unknown> | null;
};

export type SchemaApplySnapshotObject = {
  id: string;
  nameSingular: string;
  fields: SchemaApplySnapshotField[];
};

// Indexes with a composite sub-field are left out: a schema request cannot express one.
export type SchemaApplySnapshotIndex = {
  id: string;
  objectNameSingular: string;
  fieldNames: string[];
  indexType: IndexType;
  isUnique: boolean;
};

// `name` is the display name, with any `{objectLabelPlural}` template resolved.
export type SchemaApplySnapshotView = {
  id: string;
  objectNameSingular: string;
  name: string;
};

export type SchemaApplySnapshot = {
  objects: SchemaApplySnapshotObject[];
  indexes: SchemaApplySnapshotIndex[];
  views: SchemaApplySnapshotView[];
};
