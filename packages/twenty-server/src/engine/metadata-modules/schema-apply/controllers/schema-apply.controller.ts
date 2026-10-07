import {
  Body,
  Controller,
  HttpCode,
  HttpStatus,
  Post,
  UseFilters,
  UseGuards,
  UsePipes,
  ValidationPipe,
} from '@nestjs/common';

import { PermissionFlagType } from 'twenty-shared/constants';
import { ApiPath } from 'twenty-shared/types';

import { ApplicationRestApiExceptionFilter } from 'src/engine/core-modules/application/application-rest-api-exception.filter';
import { WorkspaceEntity } from 'src/engine/core-modules/workspace/workspace.entity';
import { AuthWorkspace } from 'src/engine/decorators/auth/auth-workspace.decorator';
import { JwtAuthGuard } from 'src/engine/guards/jwt-auth.guard';
import { SettingsPermissionGuard } from 'src/engine/guards/settings-permission.guard';
import { WorkspaceAuthGuard } from 'src/engine/guards/workspace-auth.guard';
import { PermissionsRestApiExceptionFilter } from 'src/engine/metadata-modules/permissions/utils/permissions-rest-api-exception.filter';
import { ApplySchemaInput } from 'src/engine/metadata-modules/schema-apply/dtos/apply-schema.input';
import { SchemaApplyRestApiExceptionFilter } from 'src/engine/metadata-modules/schema-apply/filters/schema-apply-rest-api-exception.filter';
import { SchemaApplyService } from 'src/engine/metadata-modules/schema-apply/services/schema-apply.service';
import { type SchemaApplyResult } from 'src/engine/metadata-modules/schema-apply/types/schema-apply-result.type';
import { WorkspaceMigrationRunnerRestApiExceptionFilter } from 'src/engine/workspace-manager/workspace-migration/filters/workspace-migration-runner-rest-api-exception.filter';

@Controller(`${ApiPath.Rest}/metadata/schema`)
@UseGuards(
  JwtAuthGuard,
  WorkspaceAuthGuard,
  SettingsPermissionGuard(PermissionFlagType.DATA_MODEL),
)
@UseFilters(
  PermissionsRestApiExceptionFilter,
  SchemaApplyRestApiExceptionFilter,
  ApplicationRestApiExceptionFilter,
  WorkspaceMigrationRunnerRestApiExceptionFilter,
)
@UsePipes(
  new ValidationPipe({
    transform: true,
    whitelist: true,
    forbidNonWhitelisted: true,
  }),
)
export class SchemaApplyController {
  constructor(private readonly schemaApplyService: SchemaApplyService) {}

  @Post('apply')
  @HttpCode(HttpStatus.OK)
  async apply(
    @Body() input: ApplySchemaInput,
    @AuthWorkspace() { id: workspaceId }: WorkspaceEntity,
  ): Promise<{ data: SchemaApplyResult }> {
    return {
      data: await this.schemaApplyService.applySchema({
        workspaceId,
        schema: input,
      }),
    };
  }
}
