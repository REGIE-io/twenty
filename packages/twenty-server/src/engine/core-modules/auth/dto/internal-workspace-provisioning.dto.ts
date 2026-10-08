import {
  IsBoolean,
  IsDateString,
  IsEmail,
  IsNotEmpty,
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

  @IsOptional()
  @IsString()
  @IsNotEmpty()
  apiKeyName?: string;
}

export class InternalWorkspaceApiKeyDto {
  @IsOptional()
  @IsString()
  name?: string;

  @IsOptional()
  @IsDateString()
  expiresAt?: string;
}

export class InternalWorkspaceE2eMarkerDto {
  @IsString()
  organizationId: string;

  @IsString()
  workspaceSlug: string;
}

export class InternalWorkspaceRenameDto {
  @IsString()
  @IsNotEmpty()
  name: string;

  @IsString()
  @IsNotEmpty()
  slug: string;

  @IsOptional()
  @IsString()
  primaryDomain?: string;
}

export class InternalWorkspaceLookupDto {
  @IsString()
  @IsNotEmpty()
  slug: string;
}
