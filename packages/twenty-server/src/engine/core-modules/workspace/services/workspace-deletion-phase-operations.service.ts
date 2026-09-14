import { Injectable, Logger } from '@nestjs/common';
import { InjectDataSource, InjectRepository } from '@nestjs/typeorm';

import { DataSource, Repository } from 'typeorm';

import { CoreEntityCacheService } from 'src/engine/core-entity-cache/services/core-entity-cache.service';
import { BillingService } from 'src/engine/core-modules/billing/services/billing.service';
import { BillingSubscriptionService } from 'src/engine/core-modules/billing/services/billing-subscription.service';
import { DnsManagerService } from 'src/engine/core-modules/dns-manager/services/dns-manager.service';
import { EmailingDomainEntity } from 'src/engine/core-modules/emailing-domain/emailing-domain.entity';
import { EmailingDomainService } from 'src/engine/core-modules/emailing-domain/services/emailing-domain.service';
import { FileService } from 'src/engine/core-modules/file/services/file.service';
import { PhoneSearchWorkspaceCleanupService } from 'src/engine/core-modules/phone-search-index/services/phone-search-workspace-cleanup.service';
import { UserWorkspaceEntity } from 'src/engine/core-modules/user-workspace/user-workspace.entity';
import { WorkspaceService } from 'src/engine/core-modules/workspace/services/workspace.service';
import { WorkspaceEntity } from 'src/engine/core-modules/workspace/workspace.entity';
import { ALL_METADATA_ENTITY_BY_METADATA_NAME } from 'src/engine/metadata-modules/flat-entity/constant/all-metadata-entity-by-metadata-name.constant';
import { ALL_METADATA_NAMES_SORTED_ATOMICALLY } from 'src/engine/metadata-modules/flat-entity/constant/all-metadata-names-sorted-atomically.constant';
import { WorkspaceManyOrAllFlatEntityMapsCacheService } from 'src/engine/metadata-modules/flat-entity/services/workspace-many-or-all-flat-entity-maps-cache.service';
import { WorkspaceCacheStorageService } from 'src/engine/workspace-cache-storage/workspace-cache-storage.service';
import { WorkspaceDataSourceService } from 'src/engine/workspace-datasource/workspace-datasource.service';
import {
  WORKSPACE_DELETION_CLIENT_TIMEOUT_MS,
  WORKSPACE_DELETION_LOCK_TIMEOUT_MS,
  WORKSPACE_DELETION_STATEMENT_TIMEOUT_MS,
} from 'src/engine/workspace-manager/workspace-cleaner/constants/workspace-deletion-timeouts.constant';
import { WorkspaceDeletionMaintenanceService } from 'src/engine/workspace-manager/workspace-cleaner/services/workspace-deletion-maintenance.service';
import { WorkspaceFieldMetadataDeletionService } from 'src/engine/workspace-manager/workspace-cleaner/services/workspace-field-metadata-deletion.service';

const MAINTENANCE_TIMEOUTS = {
  statementTimeoutMs: WORKSPACE_DELETION_STATEMENT_TIMEOUT_MS,
  lockTimeoutMs: WORKSPACE_DELETION_LOCK_TIMEOUT_MS,
  clientTimeoutMs: WORKSPACE_DELETION_CLIENT_TIMEOUT_MS,
};

/**
 * Destructive operations used only by the resumable workspace-deletion lifecycle.
 * The long-standing WorkspaceService.deleteWorkspace path intentionally does not
 * call this service, so enabling phase one cannot change ordinary suspended
 * customer-workspace cleanup.
 */
@Injectable()
// oxlint-disable-next-line twenty/inject-workspace-repository
export class WorkspaceDeletionPhaseOperationsService {
  private readonly logger = new Logger(
    WorkspaceDeletionPhaseOperationsService.name,
  );

  constructor(
    @InjectRepository(WorkspaceEntity)
    private readonly workspaceRepository: Repository<WorkspaceEntity>,
    @InjectRepository(UserWorkspaceEntity)
    private readonly userWorkspaceRepository: Repository<UserWorkspaceEntity>,
    private readonly workspaceService: WorkspaceService,
    private readonly billingService: BillingService,
    private readonly billingSubscriptionService: BillingSubscriptionService,
    private readonly workspaceDataSourceService: WorkspaceDataSourceService,
    private readonly phoneSearchWorkspaceCleanupService: PhoneSearchWorkspaceCleanupService,
    private readonly workspaceCacheStorageService: WorkspaceCacheStorageService,
    private readonly flatEntityMapsCacheService: WorkspaceManyOrAllFlatEntityMapsCacheService,
    private readonly fileService: FileService,
    private readonly emailingDomainService: EmailingDomainService,
    private readonly dnsManagerService: DnsManagerService,
    @InjectDataSource()
    private readonly coreDataSource: DataSource,
    private readonly coreEntityCacheService: CoreEntityCacheService,
    private readonly maintenance: WorkspaceDeletionMaintenanceService,
    private readonly fieldMetadataDeletion: WorkspaceFieldMetadataDeletionService,
  ) {}

  async deleteMembers(workspaceId: string): Promise<void> {
    const memberships = await this.userWorkspaceRepository.find({
      where: { workspaceId },
      withDeleted: true,
    });

    for (const membership of memberships) {
      await this.workspaceService.handleRemoveWorkspaceMember(
        workspaceId,
        membership.userId,
        false,
      );
    }
  }

  async deleteMetadata(workspaceId: string): Promise<void> {
    const workspace = await this.workspaceRepository.findOne({
      where: { id: workspaceId },
      withDeleted: true,
    });

    if (!workspace) {
      return;
    }
    if (this.billingService.isBillingEnabled()) {
      await this.billingSubscriptionService.assertSubscriptionCanceledOrNone(
        workspaceId,
      );
    }

    for (const metadataName of ALL_METADATA_NAMES_SORTED_ATOMICALLY) {
      if (metadataName === 'fieldMetadata') {
        const deleted = await this.fieldMetadataDeletion.delete(workspaceId);

        this.logDeleted(workspaceId, metadataName, deleted);
        continue;
      }

      const entity = ALL_METADATA_ENTITY_BY_METADATA_NAME[metadataName];
      const deleted = await this.maintenance.runInTransaction(
        MAINTENANCE_TIMEOUTS,
        async (manager) =>
          (await manager.delete(entity, { workspaceId })).affected ?? 0,
      );

      this.logDeleted(workspaceId, metadataName, deleted);
    }
  }

  async deleteSchema(workspaceId: string): Promise<void> {
    await this.workspaceDataSourceService.deleteWorkspaceDBSchema(workspaceId);
    await this.phoneSearchWorkspaceCleanupService.cleanupWorkspace(workspaceId);
  }

  async deleteCaches(workspaceId: string): Promise<void> {
    await this.workspaceCacheStorageService.flush(workspaceId);
    await this.flatEntityMapsCacheService.flushFlatEntityMaps({ workspaceId });
  }

  async deleteExternalResources(workspaceId: string): Promise<void> {
    const workspace = await this.workspaceRepository.findOne({
      where: { id: workspaceId },
      withDeleted: true,
    });

    if (!workspace) {
      return;
    }
    await this.fileService.deleteWorkspaceFolder(workspaceId);

    const emailingDomains = await this.coreDataSource
      .getRepository(EmailingDomainEntity)
      .find({ where: { workspaceId } });

    await this.emailingDomainService.cleanupEmailingDomainsForWorkspace(
      workspaceId,
      emailingDomains.map(({ domain }) => domain),
    );

    if (workspace.customDomain) {
      await this.dnsManagerService.deleteHostnameSilently(
        workspace.customDomain,
      );
    }
  }

  async deleteCoreRow(workspaceId: string): Promise<void> {
    await this.maintenance.runInTransaction(
      MAINTENANCE_TIMEOUTS,
      async (manager) => {
        await manager.delete(WorkspaceEntity, { id: workspaceId });
      },
    );
    await this.coreEntityCacheService.invalidate(
      'workspaceEntity',
      workspaceId,
    );
  }

  private logDeleted(
    workspaceId: string,
    metadataName: string,
    deleted: number,
  ): void {
    if (deleted > 0) {
      this.logger.log(
        `workspace ${workspaceId}: deleted ${deleted} ${metadataName} record(s)`,
      );
    }
  }
}
