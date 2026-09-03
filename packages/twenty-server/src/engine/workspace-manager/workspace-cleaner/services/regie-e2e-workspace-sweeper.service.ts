import { Injectable, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';

import { Repository } from 'typeorm';

import {
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
    const markerRows = await this.keyValuePairRepository
      .createQueryBuilder('marker')
      .innerJoinAndSelect('marker.workspace', 'workspace')
      .withDeleted()
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
        workspace.subdomain.startsWith(REGIE_E2E_WORKSPACE_SLUG_PREFIX);

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
