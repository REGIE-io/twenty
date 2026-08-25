import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';

import { ApplicationModule } from 'src/engine/core-modules/application/application.module';
import { TokenModule } from 'src/engine/core-modules/auth/token/token.module';
import { WorkspaceManyOrAllFlatEntityMapsCacheModule } from 'src/engine/metadata-modules/flat-entity/services/workspace-many-or-all-flat-entity-maps-cache.module';
import { IndexMetadataController } from 'src/engine/metadata-modules/index-metadata/controllers/index-metadata.controller';
import { IndexMetadataEntity } from 'src/engine/metadata-modules/index-metadata/index-metadata.entity';
import { IndexMetadataResolver } from 'src/engine/metadata-modules/index-metadata/index-metadata.resolver';
import { IndexMetadataService } from 'src/engine/metadata-modules/index-metadata/services/index-metadata.service';
import { UniqueFieldMetadataIdsService } from 'src/engine/metadata-modules/index-metadata/services/unique-field-metadata-ids.service';
import { PermissionsModule } from 'src/engine/metadata-modules/permissions/permissions.module';
import { WorkspaceMigrationModule } from 'src/engine/workspace-manager/workspace-migration/workspace-migration.module';
import { WorkspaceCacheStorageModule } from 'src/engine/workspace-cache-storage/workspace-cache-storage.module';

@Module({
  imports: [
    TypeOrmModule.forFeature([IndexMetadataEntity]),
    ApplicationModule,
    TokenModule,
    PermissionsModule,
    WorkspaceMigrationModule,
    WorkspaceManyOrAllFlatEntityMapsCacheModule,
    WorkspaceCacheStorageModule,
  ],
  controllers: [IndexMetadataController],
  providers: [
    IndexMetadataResolver,
    IndexMetadataService,
    UniqueFieldMetadataIdsService,
  ],
  exports: [IndexMetadataService, UniqueFieldMetadataIdsService],
})
export class IndexMetadataModule {}
