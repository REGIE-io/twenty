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

import { ProvisionE2eMessageChannelDto } from 'src/engine/core-modules/workspace/internal/dtos/provision-e2e-message-channel.dto';
import { InternalMetadataTokenGuard } from 'src/engine/core-modules/workspace/internal/guards/internal-metadata-token.guard';
import { InternalE2eMessageChannelService } from 'src/engine/core-modules/workspace/internal/internal-e2e-message-channel.service';
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
export class InternalE2eMessageChannelController {
  constructor(private readonly fixture: InternalE2eMessageChannelService) {}

  @Post(':workspaceId/e2e/message-channel')
  @HttpCode(HttpStatus.OK)
  provision(
    @Param('workspaceId', new ParseUUIDPipe({ version: '4' }))
    workspaceId: string,
    @Body() body: ProvisionE2eMessageChannelDto,
  ): Promise<{
    connectedAccountId: string;
    messageChannelId: string;
    created: boolean;
  }> {
    return this.fixture.provision(workspaceId, body);
  }
}
