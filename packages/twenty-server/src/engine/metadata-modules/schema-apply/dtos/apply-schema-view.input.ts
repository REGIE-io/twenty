import { IsIn, IsNotEmpty, IsString } from 'class-validator';
import { ViewType } from 'twenty-shared/types';

export class ApplySchemaViewInput {
  @IsString()
  @IsNotEmpty()
  objectNameSingular: string;

  @IsString()
  @IsNotEmpty()
  name: string;

  @IsString()
  @IsNotEmpty()
  icon: string;

  @IsIn([ViewType.TABLE])
  type: ViewType.TABLE;
}
