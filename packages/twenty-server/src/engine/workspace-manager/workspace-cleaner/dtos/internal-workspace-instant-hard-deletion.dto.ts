import { IsString, Matches } from 'class-validator';
import { InternalWorkspaceCiOwnershipDto } from 'src/engine/core-modules/auth/dto/internal-workspace-provisioning.dto';

export class InternalWorkspaceInstantHardDeletionDto extends InternalWorkspaceCiOwnershipDto {
  @IsString()
  @Matches(/^org_e2e_/)
  organizationId: string;

  @IsString()
  @Matches(/^org-e2e-/)
  workspaceSlug: string;
}
