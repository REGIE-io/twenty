import { Transform } from 'class-transformer';
import { IsEmail, IsIn, IsString } from 'class-validator';

import {
  WORKSPACE_MEMBER_PROFILE_POLICIES,
  type WorkspaceMemberProfilePolicy,
} from 'src/engine/core-modules/workspace/internal/types/internal-workspace-member-provisioning.type';

export class UpdateWorkspaceMemberProfileDto {
  @Transform(({ value }) =>
    typeof value === 'string' ? value.trim().toLowerCase() : value,
  )
  @IsEmail()
  email: string;

  @IsString()
  firstName: string;

  @IsString()
  lastName: string;

  @IsIn(WORKSPACE_MEMBER_PROFILE_POLICIES)
  profilePolicy: WorkspaceMemberProfilePolicy;
}
