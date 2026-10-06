import { Type } from 'class-transformer';
import {
  IsBoolean,
  IsDateString,
  IsEmail,
  IsOptional,
  IsString,
  IsInt,
  IsObject,
  Matches,
  MaxLength,
  Min,
  ValidateNested,
} from 'class-validator';
import {
  REGIE_CI_REPOSITORY_PATTERN,
  REGIE_CI_RUN_PATTERN,
  REGIE_CI_JOB_PATTERN,
} from 'src/engine/core-modules/auth/utils/regie-ci-workspace-marker.util';

export class RegieCiWorkspaceOwnerDto {
  @IsString()
  @MaxLength(201)
  @Matches(REGIE_CI_REPOSITORY_PATTERN)
  repository: string;

  @IsString()
  @MaxLength(128)
  @Matches(REGIE_CI_RUN_PATTERN)
  runId: string;

  @IsInt()
  @Min(1)
  runAttempt: number;

  @IsString()
  @MaxLength(128)
  @Matches(REGIE_CI_JOB_PATTERN)
  job: string;
}

export class InternalWorkspaceCiOwnershipDto {
  @IsOptional()
  @IsObject()
  @ValidateNested()
  @Type(() => RegieCiWorkspaceOwnerDto)
  ciOwner?: RegieCiWorkspaceOwnerDto;
}

export class InternalWorkspaceProvisioningDto extends InternalWorkspaceCiOwnershipDto {
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

export class InternalWorkspaceE2eMarkerDto extends InternalWorkspaceCiOwnershipDto {
  @IsString()
  organizationId: string;

  @IsString()
  workspaceSlug: string;
}
