import { Injectable, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';

import { Repository } from 'typeorm';

import {
  REGIE_E2E_LEAK_GRACE_PERIOD_MS,
  REGIE_E2E_ORGANIZATION_ID_PREFIX,
  REGIE_E2E_PURGE_BATCH_SIZE,
  REGIE_E2E_PURGE_GRACE_PERIOD_MS,
  REGIE_E2E_WORKSPACE_MARKER_KEY,
  REGIE_E2E_WORKSPACE_SLUG_PREFIX,
  type RegieE2eWorkspaceMarker,
} from 'src/engine/core-modules/auth/constants/regie-e2e-workspace-marker.constant';
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
  ) {}

  async purgeQuarantinedWorkspaces(now = new Date()): Promise<number> {
    const cutoff = new Date(now.getTime() - REGIE_E2E_PURGE_GRACE_PERIOD_MS);
    const markerRows = await this.markedE2eWorkspaceQuery({ withDeleted: true })
      .andWhere('workspace.deletedAt <= :cutoff', { cutoff })
      .orderBy('workspace.deletedAt', 'ASC')
      .limit(REGIE_E2E_PURGE_BATCH_SIZE)
      .getMany();

    let deletedCount = 0;

    for (const markerRow of markerRows) {
      const workspace = markerRow.workspace;

      if (!this.isPersistentlyMarkedE2eWorkspace(markerRow)) {
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

  async quarantineLeakedWorkspaces(now = new Date()): Promise<number> {
    const cutoff = new Date(now.getTime() - REGIE_E2E_LEAK_GRACE_PERIOD_MS);
    const markerRows = await this.markedE2eWorkspaceQuery({
      withDeleted: false,
    })
      .andWhere('workspace.deletedAt IS NULL')
      .andWhere('workspace.createdAt <= :cutoff', { cutoff })
      .orderBy('workspace.createdAt', 'ASC')
      .limit(REGIE_E2E_PURGE_BATCH_SIZE)
      .getMany();

    let quarantinedCount = 0;

    for (const markerRow of markerRows) {
      const workspace = markerRow.workspace;

      if (!this.isPersistentlyMarkedE2eWorkspace(markerRow)) {
        this.logger.warn(
          `Refusing to quarantine workspace ${workspace.id}: invalid Regie E2E marker`,
        );
        continue;
      }

      try {
        await this.workspaceService.suspendWorkspace(workspace.id);
        await this.workspaceService.deleteWorkspace(workspace.id, true);
        quarantinedCount += 1;
        this.logger.log(
          `Quarantined leaked Regie E2E workspace ${workspace.id}`,
        );
      } catch (error) {
        this.logger.error(
          `Failed to quarantine leaked Regie E2E workspace ${workspace.id}`,
          error,
        );
      }
    }

    return quarantinedCount;
  }

  private markedE2eWorkspaceQuery({ withDeleted }: { withDeleted: boolean }) {
    const query = this.keyValuePairRepository.createQueryBuilder('marker');

    if (withDeleted) {
      query.withDeleted();
    }

    return query
      .innerJoinAndSelect('marker.workspace', 'workspace')
      .where('marker.key = :key', { key: REGIE_E2E_WORKSPACE_MARKER_KEY })
      .andWhere('marker.type = :type', {
        type: KeyValuePairType.USER_VARIABLE,
      })
      .andWhere("marker.value ->> 'ephemeral' = 'true'")
      .andWhere(
        "marker.value ->> 'organizationId' LIKE 'org\\_e2e\\_%' ESCAPE '\\'",
      )
      .andWhere("workspace.subdomain LIKE 'org-e2e-%'");
  }

  private isPersistentlyMarkedE2eWorkspace(
    markerRow: KeyValuePairEntity,
  ): boolean {
    const workspace = markerRow.workspace;
    const marker = markerRow.value as unknown as RegieE2eWorkspaceMarker | null;

    return (
      marker?.ephemeral === true &&
      typeof marker.organizationId === 'string' &&
      marker.organizationId.startsWith(REGIE_E2E_ORGANIZATION_ID_PREFIX) &&
      typeof marker.workspaceSlug === 'string' &&
      marker.workspaceSlug === workspace.subdomain &&
      workspace.subdomain.startsWith(REGIE_E2E_WORKSPACE_SLUG_PREFIX)
    );
  }
}
