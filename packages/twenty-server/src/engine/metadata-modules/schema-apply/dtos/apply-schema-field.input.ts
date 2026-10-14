import { Type } from 'class-transformer';
import {
  ArrayMaxSize,
  IsArray,
  IsBoolean,
  IsEnum,
  IsIn,
  IsNotEmpty,
  IsNumber,
  IsObject,
  IsOptional,
  IsString,
  ValidateNested,
} from 'class-validator';
import {
  FieldMetadataType,
  RelationOnDeleteAction,
  RelationType,
  type TagColor,
} from 'twenty-shared/types';

import { IsValidMetadataName } from 'src/engine/decorators/metadata/is-valid-metadata-name.decorator';
import { SCHEMA_APPLY_MAX_ITEMS } from 'src/engine/metadata-modules/schema-apply/constants/schema-apply-max-items.constant';

export class ApplySchemaFieldOptionInput {
  @IsString()
  @IsNotEmpty()
  value: string;

  @IsString()
  @IsNotEmpty()
  label: string;

  @IsString()
  @IsNotEmpty()
  color: TagColor;

  @IsNumber()
  position: number;
}

export class ApplySchemaFieldRelationInput {
  @IsIn([RelationType.MANY_TO_ONE])
  type: RelationType.MANY_TO_ONE;

  @IsString()
  @IsNotEmpty()
  targetObjectNameSingular: string;

  @IsString()
  @IsNotEmpty()
  @IsValidMetadataName()
  targetFieldName: string;

  @IsString()
  @IsNotEmpty()
  targetFieldLabel: string;

  @IsString()
  @IsNotEmpty()
  targetFieldIcon: string;

  @IsOptional()
  @IsIn([RelationOnDeleteAction.CASCADE, RelationOnDeleteAction.SET_NULL])
  onDelete?: RelationOnDeleteAction.CASCADE | RelationOnDeleteAction.SET_NULL;
}

export class ApplySchemaFieldInput {
  @IsString()
  @IsNotEmpty()
  objectNameSingular: string;

  @IsString()
  @IsNotEmpty()
  @IsValidMetadataName()
  name: string;

  @IsString()
  @IsNotEmpty()
  label: string;

  @IsEnum(FieldMetadataType)
  type: FieldMetadataType;

  @IsOptional()
  @IsString()
  description?: string;

  @IsOptional()
  @IsString()
  icon?: string;

  @IsOptional()
  @IsBoolean()
  isNullable?: boolean;

  @IsOptional()
  @IsBoolean()
  isLabelSyncedWithName?: boolean;

  @IsOptional()
  @IsObject()
  settings?: Record<string, unknown>;

  @IsOptional()
  @IsArray()
  @ArrayMaxSize(SCHEMA_APPLY_MAX_ITEMS.fieldOptions)
  @ValidateNested({ each: true })
  @Type(() => ApplySchemaFieldOptionInput)
  options?: ApplySchemaFieldOptionInput[];

  @IsOptional()
  @ValidateNested()
  @Type(() => ApplySchemaFieldRelationInput)
  relation?: ApplySchemaFieldRelationInput;
}
