import { Type } from 'class-transformer';
import { IsArray, ValidateNested } from 'class-validator';

import { CreateFieldInput } from 'src/engine/metadata-modules/field-metadata/dtos/create-field.input';
import { UpdateOneFieldMetadataInput } from 'src/engine/metadata-modules/field-metadata/dtos/update-field.input';

export class CreateAndUpdateManyFieldsInput {
  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => CreateFieldInput)
  create: CreateFieldInput[];

  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => UpdateOneFieldMetadataInput)
  update: UpdateOneFieldMetadataInput[];
}
