import {
  IsBoolean,
  IsDateString,
  IsEmail,
  IsOptional,
  IsString,
} from 'class-validator';

export class InternalWorkspaceProvisioningDto {
  @IsString()
  name: string;

  @IsString()
  slug: string;

  @IsOptional()
  @IsString()
  primaryDomain?: string;

  @IsOptional()
  @IsEmail()
  serviceUserEmail?: string;

  @IsOptional()
  @IsBoolean()
  ephemeral?: boolean;

  @IsOptional()
  @IsString()
  organizationId?: string;
}

export class InternalWorkspaceApiKeyDto {
  @IsOptional()
  @IsString()
  name?: string;

  @IsOptional()
  @IsDateString()
  expiresAt?: string;
}
