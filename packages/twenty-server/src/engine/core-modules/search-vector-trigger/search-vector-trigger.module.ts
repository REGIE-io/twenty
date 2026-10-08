import { Module } from '@nestjs/common';

import { TypeORMModule } from 'src/database/typeorm/typeorm.module';
import { FeatureFlagModule } from 'src/engine/core-modules/feature-flag/feature-flag.module';
import { SearchVectorBackfillReconcileCronCommand } from 'src/engine/core-modules/search-vector-trigger/commands/search-vector-backfill-reconcile.cron.command';
import { SearchVectorBackfillService } from 'src/engine/core-modules/search-vector-trigger/services/search-vector-backfill.service';
import { SearchVectorTriggerConversionService } from 'src/engine/core-modules/search-vector-trigger/services/search-vector-trigger-conversion.service';
import { WorkspaceCacheModule } from 'src/engine/workspace-cache/workspace-cache.module';

@Module({
  imports: [WorkspaceCacheModule, FeatureFlagModule, TypeORMModule],
  providers: [
    SearchVectorTriggerConversionService,
    SearchVectorBackfillService,
    SearchVectorBackfillReconcileCronCommand,
  ],
  exports: [
    SearchVectorTriggerConversionService,
    SearchVectorBackfillService,
    SearchVectorBackfillReconcileCronCommand,
  ],
})
export class SearchVectorTriggerModule {}
