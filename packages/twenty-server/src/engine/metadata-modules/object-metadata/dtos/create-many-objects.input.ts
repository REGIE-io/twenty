import { Type } from 'class-transformer';
import { ArrayNotEmpty, IsArray, ValidateNested } from 'class-validator';

import { CreateObjectInput } from 'src/engine/metadata-modules/object-metadata/dtos/create-object.input';

export class CreateManyObjectsInput {
  @IsArray()
  @ArrayNotEmpty()
  @ValidateNested({ each: true })
  @Type(() => CreateObjectInput)
  objects: CreateObjectInput[];
}
