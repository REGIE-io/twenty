import { type IndexType } from 'src/engine/metadata-modules/index-metadata/types/indexType.types';
import { type ApplySchemaFieldSettingsInput } from 'src/engine/metadata-modules/schema-apply/dtos/apply-schema-field-settings.input';
import { type ApplySchemaFieldInput } from 'src/engine/metadata-modules/schema-apply/dtos/apply-schema-field.input';
import { type ApplySchemaIndexInput } from 'src/engine/metadata-modules/schema-apply/dtos/apply-schema-index.input';
import { type ApplySchemaObjectInput } from 'src/engine/metadata-modules/schema-apply/dtos/apply-schema-object.input';
import { type ApplySchemaViewInput } from 'src/engine/metadata-modules/schema-apply/dtos/apply-schema-view.input';

export type SchemaApplyPlannedIndex = ApplySchemaIndexInput & {
  indexType: IndexType;
};

export type SchemaApplyPlan = {
  objects: { input: ApplySchemaObjectInput; isMissing: boolean }[];
  fields: { input: ApplySchemaFieldInput; isMissing: boolean }[];
  fieldSettings: {
    input: ApplySchemaFieldSettingsInput;
    fieldId: string;
    mergedSettings: Record<string, unknown>;
    isChanged: boolean;
  }[];
  indexes: { input: SchemaApplyPlannedIndex; isMissing: boolean }[];
  views: { input: ApplySchemaViewInput; isMissing: boolean }[];
};
