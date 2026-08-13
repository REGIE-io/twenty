import {
  Body,
  Controller,
  Get,
  Post,
  UseFilters,
  UseGuards,
  UsePipes,
  ValidationPipe,
} from '@nestjs/common';

import { PermissionFlagType } from 'twenty-shared/constants';

import { WorkspaceEntity } from 'src/engine/core-modules/workspace/workspace.entity';
import { AuthWorkspace } from 'src/engine/decorators/auth/auth-workspace.decorator';
import { JwtAuthGuard } from 'src/engine/guards/jwt-auth.guard';
import { SettingsPermissionGuard } from 'src/engine/guards/settings-permission.guard';
import { WorkspaceAuthGuard } from 'src/engine/guards/workspace-auth.guard';
import { WorkspaceManyOrAllFlatEntityMapsCacheService } from 'src/engine/metadata-modules/flat-entity/services/workspace-many-or-all-flat-entity-maps-cache.service';
import { CreateIndexInput } from 'src/engine/metadata-modules/index-metadata/dtos/create-index.input';
import { IndexMetadataService } from 'src/engine/metadata-modules/index-metadata/services/index-metadata.service';
import { PermissionsRestApiExceptionFilter } from 'src/engine/metadata-modules/permissions/utils/permissions-rest-api-exception.filter';
import { ApplicationRestApiExceptionFilter } from 'src/engine/core-modules/application/application-rest-api-exception.filter';

type RestIndexMetadata = {
  id: string;
  name: string;
  objectMetadataId: string;
  indexType: string;
  isUnique: boolean;
  isCustom: boolean;
  fields: Array<{ fieldMetadataId: string; subFieldName: string | null }>;
};

// The GraphQL settings surface is not available to service API keys. This
// endpoint deliberately delegates to IndexMetadataService so index creation
// still goes through validation, workspace migrations, and cache refreshes.
@Controller('rest/metadata/indexes')
@UseGuards(
  JwtAuthGuard,
  WorkspaceAuthGuard,
  SettingsPermissionGuard(PermissionFlagType.DATA_MODEL),
)
@UseFilters(
  PermissionsRestApiExceptionFilter,
  ApplicationRestApiExceptionFilter,
)
@UsePipes(new ValidationPipe({ transform: true, whitelist: true }))
export class IndexMetadataController {
  constructor(
    private readonly indexMetadataService: IndexMetadataService,
    private readonly flatEntityMapsCacheService: WorkspaceManyOrAllFlatEntityMapsCacheService,
  ) {}

  @Get()
  async findMany(
    @AuthWorkspace() { id: workspaceId }: WorkspaceEntity,
  ): Promise<{ data: RestIndexMetadata[] }> {
    const { flatIndexMaps } =
      await this.flatEntityMapsCacheService.getOrRecomputeManyOrAllFlatEntityMaps(
        { workspaceId, flatMapsKeys: ['flatIndexMaps'] },
      );

    return {
      data: Object.values(flatIndexMaps.byUniversalIdentifier)
        .filter(
          (index): index is NonNullable<typeof index> => index !== undefined,
        )
        .map((index) => this.toRestIndexMetadata(index)),
    };
  }

  @Post()
  async createOne(
    @Body() input: CreateIndexInput,
    @AuthWorkspace() { id: workspaceId }: WorkspaceEntity,
  ): Promise<RestIndexMetadata> {
    return this.toRestIndexMetadata(
      await this.indexMetadataService.createOne({
        createIndexInput: input,
        workspaceId,
      }),
    );
  }

  private toRestIndexMetadata(index: {
    id: string;
    name: string;
    objectMetadataId: string;
    indexType: string;
    isUnique: boolean;
    isCustom: boolean;
    flatIndexFieldMetadatas: Array<{
      fieldMetadataId: string;
      subFieldName?: string | null;
      order: number;
    }>;
  }): RestIndexMetadata {
    return {
      id: index.id,
      name: index.name,
      objectMetadataId: index.objectMetadataId,
      indexType: index.indexType,
      isUnique: index.isUnique,
      isCustom: index.isCustom,
      fields: [...index.flatIndexFieldMetadatas]
        .sort((left, right) => left.order - right.order)
        .map((field) => ({
          fieldMetadataId: field.fieldMetadataId,
          subFieldName: field.subFieldName ?? null,
        })),
    };
  }
}
