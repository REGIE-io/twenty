import {
  Body,
  Controller,
  HttpCode,
  HttpStatus,
  Param,
  ParseUUIDPipe,
  Patch,
  Post,
  UseGuards,
  UsePipes,
  ValidationPipe,
} from '@nestjs/common';

import { ProvisionWorkspaceMemberDto } from 'src/engine/core-modules/workspace/internal/dtos/provision-workspace-member.dto';
import { UpdateWorkspaceMemberProfileDto } from 'src/engine/core-modules/workspace/internal/dtos/update-workspace-member-profile.dto';
import { InternalMetadataTokenGuard } from 'src/engine/core-modules/workspace/internal/guards/internal-metadata-token.guard';
import { InternalWorkspaceMemberProvisioningService } from 'src/engine/core-modules/workspace/internal/internal-workspace-member-provisioning.service';
import {
  type ProvisionWorkspaceMemberResult,
  type UpdateWorkspaceMemberProfileResult,
} from 'src/engine/core-modules/workspace/internal/types/internal-workspace-member-provisioning.type';
import { NoPermissionGuard } from 'src/engine/guards/no-permission.guard';

@Controller('internal/workspaces')
@UseGuards(InternalMetadataTokenGuard, NoPermissionGuard)
@UsePipes(
  new ValidationPipe({
    transform: true,
    whitelist: true,
    forbidNonWhitelisted: true,
  }),
)
export class InternalWorkspaceMemberProvisioningController {
  constructor(
    private readonly internalWorkspaceMemberProvisioningService: InternalWorkspaceMemberProvisioningService,
  ) {}

  @Patch(':workspaceId/members/:workspaceMemberId')
  @HttpCode(HttpStatus.OK)
  async updateWorkspaceMemberProfile(
    @Param('workspaceId', new ParseUUIDPipe({ version: '4' }))
    workspaceId: string,
    @Param('workspaceMemberId', new ParseUUIDPipe({ version: '4' }))
    workspaceMemberId: string,
    @Body() body: UpdateWorkspaceMemberProfileDto,
  ): Promise<UpdateWorkspaceMemberProfileResult> {
    return await this.internalWorkspaceMemberProvisioningService.updateWorkspaceMemberProfile(
      {
        workspaceId,
        workspaceMemberId,
        email: body.email,
        firstName: body.firstName,
        lastName: body.lastName,
        profilePolicy: body.profilePolicy,
      },
    );
  }

  @Post(':workspaceId/members')
  @HttpCode(HttpStatus.OK)
  async provisionWorkspaceMember(
    @Param('workspaceId', new ParseUUIDPipe({ version: '4' }))
    workspaceId: string,
    @Body() body: ProvisionWorkspaceMemberDto,
  ): Promise<ProvisionWorkspaceMemberResult> {
    return await this.internalWorkspaceMemberProvisioningService.provisionWorkspaceMember(
      {
        workspaceId,
        id: body.id,
        email: body.email,
        firstName: body.firstName,
        lastName: body.lastName,
      },
    );
  }
}
