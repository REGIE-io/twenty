import { Type } from 'class-transformer';
import { ArrayNotEmpty, IsArray, ValidateNested } from 'class-validator';

import { CreateIndexInput } from 'src/engine/metadata-modules/index-metadata/dtos/create-index.input';

export class CreateManyIndexesInput {
  @IsArray()
  @ArrayNotEmpty()
  @ValidateNested({ each: true })
  @Type(() => CreateIndexInput)
  indexes: CreateIndexInput[];
}
