import { Module } from '@nestjs/common';

import { SearchVectorTriggerConversionService } from 'src/engine/core-modules/search-vector-trigger/services/search-vector-trigger-conversion.service';
import { WorkspaceCacheModule } from 'src/engine/workspace-cache/workspace-cache.module';

@Module({
  imports: [WorkspaceCacheModule],
  providers: [SearchVectorTriggerConversionService],
  exports: [SearchVectorTriggerConversionService],
})
export class SearchVectorTriggerModule {}
