import {
  ArrayMaxSize,
  ArrayNotEmpty,
  IsArray,
  IsBoolean,
  IsEnum,
  IsNotEmpty,
  IsOptional,
  IsString,
} from 'class-validator';

import { IndexType } from 'src/engine/metadata-modules/index-metadata/types/indexType.types';
import { SCHEMA_APPLY_MAX_ITEMS } from 'src/engine/metadata-modules/schema-apply/constants/schema-apply-max-items.constant';

export class ApplySchemaIndexInput {
  @IsString()
  @IsNotEmpty()
  objectNameSingular: string;

  // Order matters: Postgres uses the leading column first.
  @IsArray()
  @ArrayNotEmpty()
  @ArrayMaxSize(SCHEMA_APPLY_MAX_ITEMS.indexFields)
  @IsString({ each: true })
  @IsNotEmpty({ each: true })
  fieldNames: string[];

  @IsBoolean()
  isUnique: boolean;

  @IsOptional()
  @IsEnum(IndexType)
  indexType?: IndexType;
}
