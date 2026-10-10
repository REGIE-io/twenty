import { IsNotEmpty, IsOptional, IsString } from 'class-validator';

import { IsValidMetadataName } from 'src/engine/decorators/metadata/is-valid-metadata-name.decorator';

export class ApplySchemaObjectInput {
  @IsString()
  @IsNotEmpty()
  @IsValidMetadataName()
  nameSingular: string;

  @IsString()
  @IsNotEmpty()
  @IsValidMetadataName()
  namePlural: string;

  @IsString()
  @IsNotEmpty()
  labelSingular: string;

  @IsString()
  @IsNotEmpty()
  labelPlural: string;

  @IsOptional()
  @IsString()
  icon?: string;

  @IsOptional()
  @IsString()
  description?: string;
}
