import { Module } from '@nestjs/common';

import { WorkspaceIteratorModule } from 'src/database/commands/command-runners/workspace-iterator.module';
import { AddCalendarEventSummaryTabCommand } from 'src/database/commands/upgrade-version-command/2-32/2-32-workspace-command-1786609782000-add-calendar-event-summary-tab.command';
import { AddWorkspaceMemberUiScaleFieldCommand } from 'src/database/commands/upgrade-version-command/2-32/2-32-workspace-command-1786700000000-add-workspace-member-ui-scale-field.command';
import { InitializePersonPhoneSearchLookupCommand } from 'src/database/commands/upgrade-version-command/2-32/2-32-workspace-command-1786800001000-initialize-person-phone-search-lookup.command';
import { ApplicationModule } from 'src/engine/core-modules/application/application.module';
import { PhoneSearchIndexModule } from 'src/engine/core-modules/phone-search-index/phone-search-index.module';
import { WorkspaceCacheModule } from 'src/engine/workspace-cache/workspace-cache.module';
import { WorkspaceMigrationModule } from 'src/engine/workspace-manager/workspace-migration/workspace-migration.module';

@Module({
  imports: [
    ApplicationModule,
    WorkspaceCacheModule,
    WorkspaceIteratorModule,
    WorkspaceMigrationModule,
    PhoneSearchIndexModule,
  ],
  providers: [
    AddCalendarEventSummaryTabCommand,
    AddWorkspaceMemberUiScaleFieldCommand,
    InitializePersonPhoneSearchLookupCommand,
  ],
})
export class V2_32_UpgradeVersionCommandModule {}
