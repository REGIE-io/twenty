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

import { InternalMetadataTokenGuard } from 'src/engine/core-modules/workspace/internal/guards/internal-metadata-token.guard';
import { NoPermissionGuard } from 'src/engine/guards/no-permission.guard';
import { InternalWorkspaceInstantHardDeletionDto } from 'src/engine/workspace-manager/workspace-cleaner/dtos/internal-workspace-instant-hard-deletion.dto';
import { InternalWorkspaceInstantHardDeletionService } from 'src/engine/workspace-manager/workspace-cleaner/services/internal-workspace-instant-hard-deletion.service';

@Controller('internal/workspaces')
@UseGuards(InternalMetadataTokenGuard, NoPermissionGuard)
@UsePipes(
  new ValidationPipe({
    transform: true,
    whitelist: true,
    forbidNonWhitelisted: true,
  }),
)
export class InternalWorkspaceInstantHardDeletionController {
  constructor(
    private readonly service: InternalWorkspaceInstantHardDeletionService,
  ) {}

  @Post(':workspaceId/instant-hard-deletion')
  @HttpCode(HttpStatus.ACCEPTED)
  requestInstantHardDeletion(
    @Param('workspaceId', new ParseUUIDPipe({ version: '4' }))
    workspaceId: string,
    @Body() body: InternalWorkspaceInstantHardDeletionDto,
  ) {
    return this.service.request(workspaceId, body);
  }
}
