import {
  Body,
  Controller,
  HttpCode,
  HttpStatus,
  Param,
  ParseUUIDPipe,
  Post,
  UseGuards,
  UsePipes,
  ValidationPipe,
} from '@nestjs/common';

import { AttachConnectedAccountDto } from 'src/engine/core-modules/workspace/internal/dtos/attach-connected-account.dto';
import { InternalMetadataTokenGuard } from 'src/engine/core-modules/workspace/internal/guards/internal-metadata-token.guard';
import { InternalConnectedAccountProvisioningService } from 'src/engine/core-modules/workspace/internal/internal-connected-account-provisioning.service';
import {
  type AttachConnectedAccountResult,
  type DetachConnectedAccountResult,
} from 'src/engine/core-modules/workspace/internal/types/internal-connected-account-provisioning.type';
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
export class InternalConnectedAccountProvisioningController {
  constructor(
    private readonly internalConnectedAccountProvisioningService: InternalConnectedAccountProvisioningService,
  ) {}

  @Post(':workspaceId/connected-accounts')
  @HttpCode(HttpStatus.OK)
  async attachConnectedAccount(
    @Param('workspaceId', new ParseUUIDPipe({ version: '4' }))
    workspaceId: string,
    @Body() body: AttachConnectedAccountDto,
  ): Promise<AttachConnectedAccountResult> {
    return await this.internalConnectedAccountProvisioningService.attachConnectedAccount(
      {
        workspaceId,
        provider: body.provider,
        handle: body.handle,
        memberEmail: body.memberEmail,
        regieMailboxId: body.regieMailboxId,
        calendarVisibility: body.calendarVisibility,
        verifyTokenDelegation: body.verifyTokenDelegation,
      },
    );
  }

  @Post(':workspaceId/connected-accounts/:connectedAccountId/detach')
  @HttpCode(HttpStatus.OK)
  async detachConnectedAccount(
    @Param('workspaceId', new ParseUUIDPipe({ version: '4' }))
    workspaceId: string,
    @Param('connectedAccountId', new ParseUUIDPipe({ version: '4' }))
    connectedAccountId: string,
  ): Promise<DetachConnectedAccountResult> {
    return await this.internalConnectedAccountProvisioningService.detachConnectedAccount(
      { workspaceId, connectedAccountId },
    );
  }
}
