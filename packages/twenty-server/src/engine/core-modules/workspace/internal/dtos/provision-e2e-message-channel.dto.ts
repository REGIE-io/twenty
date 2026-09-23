import { Type } from 'class-transformer';
import {
  IsEmail,
  IsObject,
  IsString,
  Matches,
  MaxLength,
  ValidateNested,
} from 'class-validator';

import { RegieCiWorkspaceOwnerDto } from 'src/engine/core-modules/auth/dto/internal-workspace-provisioning.dto';

export class ProvisionE2eMessageChannelDto {
  @IsObject()
  @ValidateNested()
  @Type(() => RegieCiWorkspaceOwnerDto)
  ciOwner: RegieCiWorkspaceOwnerDto;

  @IsEmail()
  @MaxLength(254)
  memberEmail: string;

  @IsString()
  @Matches(/^crm\.message\.[a-z0-9][a-z0-9._-]{0,127}@example\.test$/)
  handle: string;
}
