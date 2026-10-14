import { IsNotEmpty, IsObject, IsString } from 'class-validator';

export class ApplySchemaFieldSettingsInput {
  @IsString()
  @IsNotEmpty()
  objectNameSingular: string;

  @IsString()
  @IsNotEmpty()
  name: string;

  @IsObject()
  settings: Record<string, unknown>;
}
