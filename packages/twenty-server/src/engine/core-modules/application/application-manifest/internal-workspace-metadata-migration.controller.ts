import {
  BadRequestException,
  Body,
  Controller,
  Headers,
  InternalServerErrorException,
  Param,
  Post,
  UnauthorizedException,
} from '@nestjs/common';

import { type Manifest } from 'twenty-shared/application';

import { ApplicationManifestMigrationService } from 'src/engine/core-modules/application/application-manifest/application-manifest-migration.service';
import { ApplicationService } from 'src/engine/core-modules/application/application.service';
import { WorkspaceMigrationBuilderException } from 'src/engine/workspace-manager/workspace-migration/exceptions/workspace-migration-builder-exception';
import { buildMetadataValidationErrorPayload } from 'src/engine/workspace-manager/workspace-migration/interceptors/utils/build-metadata-validation-error-payload.util';

type SyncManifestBody = {
  manifest?: Manifest;
  dryRun?: boolean;
};

@Controller('internal/workspaces/:workspaceId/metadata-migrations')
export class InternalWorkspaceMetadataMigrationController {
  constructor(
    private readonly applicationService: ApplicationService,
    private readonly applicationManifestMigrationService: ApplicationManifestMigrationService,
  ) {}

  @Post()
  async syncManifest(
    @Param('workspaceId') workspaceId: string,
    @Headers('x-internal-token') internalToken: string | string[] | undefined,
    @Body() body: SyncManifestBody,
  ) {
    const expectedToken =
      process.env.REGIE_INTERNAL_METADATA_TOKEN ??
      process.env.TWENTY_INTERNAL_METADATA_TOKEN;

    if (!expectedToken) {
      throw new InternalServerErrorException(
        'Internal metadata migration token is not configured',
      );
    }

    const actualToken = Array.isArray(internalToken)
      ? internalToken[0]
      : internalToken;

    if (actualToken !== expectedToken) {
      throw new UnauthorizedException('Invalid internal metadata token');
    }

    if (!body.manifest || !Array.isArray(body.manifest.objects)) {
      throw new BadRequestException('Request body must include a Twenty manifest');
    }

    const { workspaceCustomFlatApplication } =
      await this.applicationService.findWorkspaceTwentyStandardAndCustomApplicationOrThrow(
        { workspaceId },
      );

    const result = await this.applicationManifestMigrationService
      .syncMetadataFromManifest({
        manifest: body.manifest,
        workspaceId,
        ownerFlatApplication: workspaceCustomFlatApplication,
        dryRun: body.dryRun ?? false,
      })
      .catch((error) => {
        if (error instanceof WorkspaceMigrationBuilderException) {
          throw new BadRequestException({
            message: error.message,
            validation: buildMetadataValidationErrorPayload(error),
          });
        }

        throw error;
      });

    return {
      ok: true,
      dryRun: body.dryRun ?? false,
      hasSchemaMetadataChanged: result.hasSchemaMetadataChanged,
      actionCount: result.workspaceMigration.actions.length,
    };
  }
}
