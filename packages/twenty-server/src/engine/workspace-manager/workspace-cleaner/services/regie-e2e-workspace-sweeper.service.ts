import { Injectable, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';

import { Repository } from 'typeorm';
import { WorkspaceActivationStatus } from 'twenty-shared/workspace';
import { PostgresAdvisoryLockService } from 'src/database/typeorm/postgres-advisory-lock.service';

import {
  REGIE_E2E_ORGANIZATION_ID_PREFIX,
  REGIE_CI_WORKSPACE_OWNER,
  REGIE_E2E_PURGE_BATCH_SIZE,
  REGIE_E2E_PURGE_GRACE_PERIOD_MS,
  REGIE_E2E_WORKSPACE_MARKER_KEY,
  REGIE_E2E_WORKSPACE_SLUG_PREFIX,
  type RegieE2eWorkspaceMarker,
} from 'src/engine/core-modules/auth/constants/regie-e2e-workspace-marker.constant';
import {
  hasRegieCiWorkspaceMetadata,
  isValidRegieCiWorkspaceMarker,
} from 'src/engine/core-modules/auth/utils/regie-ci-workspace-marker.util';
import { CLEAN_SUSPENDED_WORKSPACES_LOCK_NAME } from 'src/engine/workspace-manager/workspace-cleaner/constants/workspace-cleanup-lock.constant';
import {
  KeyValuePairEntity,
  KeyValuePairType,
} from 'src/engine/core-modules/key-value-pair/key-value-pair.entity';
import { WorkspaceService } from 'src/engine/core-modules/workspace/services/workspace.service';

@Injectable()
export class RegieE2eWorkspaceSweeperService {
  private readonly logger = new Logger(RegieE2eWorkspaceSweeperService.name);

  constructor(
    private readonly workspaceService: WorkspaceService,
    @InjectRepository(KeyValuePairEntity)
    private readonly keyValuePairRepository: Repository<KeyValuePairEntity>,
    private readonly postgresAdvisoryLockService: PostgresAdvisoryLockService,
  ) {}

  async quarantineExpiredCiWorkspaces(now = new Date()): Promise<number> {
    const result = await this.postgresAdvisoryLockService.tryWithLock(
      CLEAN_SUSPENDED_WORKSPACES_LOCK_NAME,
      () => this.quarantineExpiredCiCandidates(now),
    );

    return result.acquired ? result.value : 0;
  }

  private async quarantineExpiredCiCandidates(now: Date): Promise<number> {
    const rows = await this.keyValuePairRepository
      .createQueryBuilder('marker')
      .innerJoinAndSelect('marker.workspace', 'workspace')
      .where('marker.key = :key', { key: REGIE_E2E_WORKSPACE_MARKER_KEY })
      .andWhere('marker.type = :type', { type: KeyValuePairType.USER_VARIABLE })
      .andWhere("marker.value ->> 'owner' = :owner", {
        owner: REGIE_CI_WORKSPACE_OWNER,
      })
      .andWhere("marker.value ->> 'ephemeral' = 'true'")
      .andWhere("marker.value ->> 'workspaceSlug' = workspace.subdomain")
      .andWhere(
        "marker.value ->> 'organizationId' LIKE 'org\\_e2e\\_%' ESCAPE '\\'",
      )
      .andWhere("workspace.subdomain LIKE 'org-e2e-%'")
      .andWhere("marker.value ->> 'expiresAt' <= :now", {
        now: now.toISOString(),
      })
      .andWhere('workspace.activationStatus = :active', {
        active: WorkspaceActivationStatus.ACTIVE,
      })
      .andWhere('workspace.deletedAt IS NULL')
      .orderBy("marker.value ->> 'expiresAt'", 'ASC')
      .addOrderBy('workspace.id', 'ASC')
      .limit(REGIE_E2E_PURGE_BATCH_SIZE)
      .getMany();
    let quarantined = 0;

    for (const row of rows) {
      const marker = row.value;
      const workspace = row.workspace;

      if (
        !isValidRegieCiWorkspaceMarker(marker, workspace.subdomain) ||
        Date.parse(marker.expiresAt) > now.getTime() ||
        workspace.activationStatus !== WorkspaceActivationStatus.ACTIVE ||
        workspace.deletedAt
      ) {
        this.logger.warn(
          `Refusing to quarantine workspace ${workspace.id}: invalid or unexpired CI lease`,
        );
        continue;
      }
      try {
        await this.workspaceService.deleteWorkspace(workspace.id, true);
        quarantined += 1;
        this.logger.log(`Quarantined expired CI workspace ${workspace.id}`);
      } catch (error) {
        this.logger.error(
          `Failed to quarantine expired CI workspace ${workspace.id}`,
          error,
        );
      }
    }

    return quarantined;
  }

  async purgeQuarantinedWorkspaces(now = new Date()): Promise<number> {
    const cutoff = new Date(now.getTime() - REGIE_E2E_PURGE_GRACE_PERIOD_MS);
    const markerRows = await this.keyValuePairRepository
      .createQueryBuilder('marker')
      .withDeleted()
      .innerJoinAndSelect('marker.workspace', 'workspace')
      .where('marker.key = :key', { key: REGIE_E2E_WORKSPACE_MARKER_KEY })
      .andWhere('marker.type = :type', {
        type: KeyValuePairType.USER_VARIABLE,
      })
      .andWhere("marker.value ->> 'ephemeral' = 'true'")
      .andWhere(
        "marker.value ->> 'organizationId' LIKE 'org\\_e2e\\_%' ESCAPE '\\'",
      )
      .andWhere("workspace.subdomain LIKE 'org-e2e-%'")
      .andWhere('workspace.deletedAt <= :cutoff', { cutoff })
      .orderBy('workspace.deletedAt', 'ASC')
      .limit(REGIE_E2E_PURGE_BATCH_SIZE)
      .getMany();

    let deletedCount = 0;

    for (const markerRow of markerRows) {
      const workspace = markerRow.workspace;
      const marker =
        markerRow.value as unknown as RegieE2eWorkspaceMarker | null;
      const isPersistentlyMarkedE2eWorkspace =
        marker?.ephemeral === true &&
        typeof marker.organizationId === 'string' &&
        marker.organizationId.startsWith(REGIE_E2E_ORGANIZATION_ID_PREFIX) &&
        typeof marker.workspaceSlug === 'string' &&
        marker.workspaceSlug === workspace.subdomain &&
        workspace.subdomain.startsWith(REGIE_E2E_WORKSPACE_SLUG_PREFIX) &&
        (!hasRegieCiWorkspaceMetadata(marker) ||
          isValidRegieCiWorkspaceMarker(marker, workspace.subdomain));

      if (!isPersistentlyMarkedE2eWorkspace) {
        this.logger.warn(
          `Refusing to purge workspace ${workspace.id}: invalid Regie E2E marker`,
        );
        continue;
      }

      try {
        await this.workspaceService.deleteWorkspace(workspace.id);
        deletedCount += 1;
        this.logger.log(
          `Purged quarantined Regie E2E workspace ${workspace.id}`,
        );
      } catch (error) {
        this.logger.error(
          `Failed to purge quarantined Regie E2E workspace ${workspace.id}`,
          error,
        );
      }
    }

    return deletedCount;
  }
}
