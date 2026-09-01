import { Module } from '@nestjs/common';

import { PhoneSearchTriggerManagerService } from 'src/engine/core-modules/phone-search-index/services/phone-search-trigger-manager.service';
import { PhoneSearchIndexBackfillService } from 'src/engine/core-modules/phone-search-index/services/phone-search-index-backfill.service';
import { PhoneSearchIndexReconcilerService } from 'src/engine/core-modules/phone-search-index/services/phone-search-index-reconciler.service';
import { PhoneSearchMetadataGateService } from 'src/engine/core-modules/phone-search-index/services/phone-search-metadata-gate.service';
import { PhoneSearchFieldLifecycleService } from 'src/engine/core-modules/phone-search-index/services/phone-search-field-lifecycle.service';
import { PhoneSearchFieldLifecycleCoordinatorService } from 'src/engine/core-modules/phone-search-index/services/phone-search-field-lifecycle-coordinator.service';
import { PhoneSearchIndexReconcilerCronCommand } from 'src/engine/core-modules/phone-search-index/commands/phone-search-index-reconciler.cron.command';

@Module({
  providers: [
    PhoneSearchTriggerManagerService,
    PhoneSearchIndexBackfillService,
    PhoneSearchIndexReconcilerService,
    PhoneSearchIndexReconcilerCronCommand,
    PhoneSearchMetadataGateService,
    PhoneSearchFieldLifecycleService,
    PhoneSearchFieldLifecycleCoordinatorService,
  ],
  exports: [
    PhoneSearchTriggerManagerService,
    PhoneSearchIndexBackfillService,
    PhoneSearchIndexReconcilerService,
    PhoneSearchMetadataGateService,
    PhoneSearchFieldLifecycleService,
    PhoneSearchFieldLifecycleCoordinatorService,
  ],
})
export class PhoneSearchIndexModule {}
