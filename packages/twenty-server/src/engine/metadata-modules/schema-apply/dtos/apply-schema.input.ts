import { Type } from 'class-transformer';
import {
  ArrayMaxSize,
  IsArray,
  IsOptional,
  ValidateNested,
} from 'class-validator';

import { SCHEMA_APPLY_MAX_ITEMS } from 'src/engine/metadata-modules/schema-apply/constants/schema-apply-max-items.constant';
import { ApplySchemaFieldSettingsInput } from 'src/engine/metadata-modules/schema-apply/dtos/apply-schema-field-settings.input';
import { ApplySchemaFieldInput } from 'src/engine/metadata-modules/schema-apply/dtos/apply-schema-field.input';
import { ApplySchemaIndexInput } from 'src/engine/metadata-modules/schema-apply/dtos/apply-schema-index.input';
import { ApplySchemaObjectInput } from 'src/engine/metadata-modules/schema-apply/dtos/apply-schema-object.input';
import { ApplySchemaViewInput } from 'src/engine/metadata-modules/schema-apply/dtos/apply-schema-view.input';

export class ApplySchemaInput {
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(SCHEMA_APPLY_MAX_ITEMS.objects)
  @ValidateNested({ each: true })
  @Type(() => ApplySchemaObjectInput)
  objects?: ApplySchemaObjectInput[];

  @IsOptional()
  @IsArray()
  @ArrayMaxSize(SCHEMA_APPLY_MAX_ITEMS.fields)
  @ValidateNested({ each: true })
  @Type(() => ApplySchemaFieldInput)
  fields?: ApplySchemaFieldInput[];

  @IsOptional()
  @IsArray()
  @ArrayMaxSize(SCHEMA_APPLY_MAX_ITEMS.fieldSettings)
  @ValidateNested({ each: true })
  @Type(() => ApplySchemaFieldSettingsInput)
  fieldSettings?: ApplySchemaFieldSettingsInput[];

  @IsOptional()
  @IsArray()
  @ArrayMaxSize(SCHEMA_APPLY_MAX_ITEMS.indexes)
  @ValidateNested({ each: true })
  @Type(() => ApplySchemaIndexInput)
  indexes?: ApplySchemaIndexInput[];

  @IsOptional()
  @IsArray()
  @ArrayMaxSize(SCHEMA_APPLY_MAX_ITEMS.views)
  @ValidateNested({ each: true })
  @Type(() => ApplySchemaViewInput)
  views?: ApplySchemaViewInput[];
}
