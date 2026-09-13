import { IsString, Matches } from 'class-validator';

export class InternalWorkspaceInstantHardDeletionDto {
  @IsString()
  @Matches(/^org_e2e_/)
  organizationId: string;

  @IsString()
  @Matches(/^org-e2e-/)
  workspaceSlug: string;
}
