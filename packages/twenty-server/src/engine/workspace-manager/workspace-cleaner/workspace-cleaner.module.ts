import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';

import { BillingModule } from 'src/engine/core-modules/billing/billing.module';
import { BillingSubscriptionEntity } from 'src/engine/core-modules/billing/entities/billing-subscription.entity';
import { WorkspaceDomainsModule } from 'src/engine/core-modules/domain/workspace-domains/workspace-domains.module';
import { EmailModule } from 'src/engine/core-modules/email/email.module';
import { MetricsModule } from 'src/engine/core-modules/metrics/metrics.module';
import { KeyValuePairEntity } from 'src/engine/core-modules/key-value-pair/key-value-pair.entity';
import { UserWorkspaceEntity } from 'src/engine/core-modules/user-workspace/user-workspace.entity';
import { UserVarsModule } from 'src/engine/core-modules/user/user-vars/user-vars.module';
import { UserModule } from 'src/engine/core-modules/user/user.module';
import { WorkspaceEntity } from 'src/engine/core-modules/workspace/workspace.entity';
import { WorkspaceModule } from 'src/engine/core-modules/workspace/workspace.module';
import { provideWorkspaceScopedRepository } from 'src/engine/twenty-orm/workspace-scoped-repository/provide-workspace-scoped-repository';
import { CleanOnboardingWorkspacesCommand } from 'src/engine/workspace-manager/workspace-cleaner/commands/clean-onboarding-workspaces.command';
import { CleanOnboardingWorkspacesCronCommand } from 'src/engine/workspace-manager/workspace-cleaner/commands/clean-onboarding-workspaces.cron.command';
import { CleanSuspendedWorkspacesCommand } from 'src/engine/workspace-manager/workspace-cleaner/commands/clean-suspended-workspaces.command';
import { CleanSuspendedWorkspacesCronCommand } from 'src/engine/workspace-manager/workspace-cleaner/commands/clean-suspended-workspaces.cron.command';
import { PurgeRegieE2eWorkspacesCommand } from 'src/engine/workspace-manager/workspace-cleaner/commands/purge-regie-e2e-workspaces.command';
import { DestroyWorkspaceCommand } from 'src/engine/workspace-manager/workspace-cleaner/commands/destroy-workspace.command';
import { RegieE2eWorkspaceDeletionDiscoveryCronCommand } from 'src/engine/workspace-manager/workspace-cleaner/commands/regie-e2e-workspace-deletion-discovery.cron.command';
import { CleanerWorkspaceService } from 'src/engine/workspace-manager/workspace-cleaner/services/cleaner.workspace-service';
import { RegieE2eWorkspaceSweeperService } from 'src/engine/workspace-manager/workspace-cleaner/services/regie-e2e-workspace-sweeper.service';
import { RegieE2eWorkspaceDeletionDiscoveryService } from 'src/engine/workspace-manager/workspace-cleaner/services/regie-e2e-workspace-deletion-discovery.service';
import { WorkspaceDeletionLifecycleService } from 'src/engine/workspace-manager/workspace-cleaner/services/workspace-deletion-lifecycle.service';
import { WorkspaceDeletionLifecycleStore } from 'src/engine/workspace-manager/workspace-cleaner/services/workspace-deletion-lifecycle.store';
import { WorkspaceDeletionCoordinatorService } from 'src/engine/workspace-manager/workspace-cleaner/services/workspace-deletion-coordinator.service';
import { WorkspaceDeletionMonitoringService } from 'src/engine/workspace-manager/workspace-cleaner/services/workspace-deletion-monitoring.service';
import { WorkspaceDeletionPhaseExecutorService } from 'src/engine/workspace-manager/workspace-cleaner/services/workspace-deletion-phase-executor.service';
import { WorkspaceDeletionPhaseRunnersService } from 'src/engine/workspace-manager/workspace-cleaner/services/workspace-deletion-phase-runners.service';
import { WorkspaceDeletionTraceService } from 'src/engine/workspace-manager/workspace-cleaner/services/workspace-deletion-trace.service';
import { WorkspaceDeletionQueueAdapter } from 'src/engine/workspace-manager/workspace-cleaner/services/workspace-deletion-queue.adapter';

@Module({
  imports: [
    TypeOrmModule.forFeature([
      WorkspaceEntity,
      UserWorkspaceEntity,
      BillingSubscriptionEntity,
      KeyValuePairEntity,
    ]),
    WorkspaceModule,
    UserVarsModule,
    UserModule,
    EmailModule,
    BillingModule,
    MetricsModule,
    WorkspaceDomainsModule,
  ],
  providers: [
    DestroyWorkspaceCommand,
    RegieE2eWorkspaceDeletionDiscoveryCronCommand,
    CleanSuspendedWorkspacesCronCommand,
    CleanSuspendedWorkspacesCommand,
    PurgeRegieE2eWorkspacesCommand,
    CleanOnboardingWorkspacesCommand,
    CleanOnboardingWorkspacesCronCommand,
    CleanerWorkspaceService,
    RegieE2eWorkspaceSweeperService,
    RegieE2eWorkspaceDeletionDiscoveryService,
    WorkspaceDeletionLifecycleService,
    WorkspaceDeletionLifecycleStore,
    WorkspaceDeletionPhaseExecutorService,
    WorkspaceDeletionCoordinatorService,
    WorkspaceDeletionMonitoringService,
    WorkspaceDeletionPhaseRunnersService,
    WorkspaceDeletionTraceService,
    WorkspaceDeletionQueueAdapter,
    provideWorkspaceScopedRepository(BillingSubscriptionEntity),
  ],
  exports: [
    CleanerWorkspaceService,
    RegieE2eWorkspaceSweeperService,
    RegieE2eWorkspaceDeletionDiscoveryService,
    WorkspaceDeletionLifecycleService,
    WorkspaceDeletionLifecycleStore,
    WorkspaceDeletionPhaseExecutorService,
    WorkspaceDeletionCoordinatorService,
    WorkspaceDeletionMonitoringService,
    WorkspaceDeletionPhaseRunnersService,
    WorkspaceDeletionTraceService,
    WorkspaceDeletionQueueAdapter,
    CleanSuspendedWorkspacesCronCommand,
    CleanOnboardingWorkspacesCronCommand,
  ],
})
export class WorkspaceCleanerModule {}
