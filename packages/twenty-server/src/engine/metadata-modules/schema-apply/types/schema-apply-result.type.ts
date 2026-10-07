import { type FieldMetadataType } from 'twenty-shared/types';

export type SchemaApplyResult = {
  objects: { nameSingular: string; id: string; created: boolean }[];
  fields: {
    objectNameSingular: string;
    name: string;
    id: string;
    type: FieldMetadataType;
    created: boolean;
  }[];
  fieldSettings: {
    objectNameSingular: string;
    name: string;
    updated: boolean;
  }[];
  indexes: {
    objectNameSingular: string;
    fieldNames: string[];
    id: string;
    created: boolean;
  }[];
  views: {
    objectNameSingular: string;
    name: string;
    id: string;
    created: boolean;
  }[];
};
