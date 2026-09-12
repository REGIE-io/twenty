import { Injectable, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';

import { type Repository } from 'typeorm';

import {
  REGIE_E2E_ORGANIZATION_ID_PREFIX,
  REGIE_E2E_WORKSPACE_MARKER_KEY,
  REGIE_E2E_WORKSPACE_SLUG_PREFIX,
  type RegieE2eWorkspaceMarker,
} from 'src/engine/core-modules/auth/constants/regie-e2e-workspace-marker.constant';
import {
  KeyValuePairEntity,
  KeyValuePairType,
} from 'src/engine/core-modules/key-value-pair/key-value-pair.entity';
import { WorkspaceDeletionKind } from 'src/engine/core-modules/workspace/types/workspace-deletion-lifecycle.type';
import { WorkspaceDeletionLifecycleStore } from 'src/engine/workspace-manager/workspace-cleaner/services/workspace-deletion-lifecycle.store';

export type WorkspaceDeletionEnqueuer = {
  enqueue(input: { workspaceId: string; jobId: string }): Promise<void>;
};

@Injectable()
export class RegieE2eWorkspaceDeletionDiscoveryService {
  private readonly logger = new Logger(
    RegieE2eWorkspaceDeletionDiscoveryService.name,
  );

  constructor(
    @InjectRepository(KeyValuePairEntity)
    private readonly markerRepository: Repository<KeyValuePairEntity>,
    private readonly lifecycleStore: WorkspaceDeletionLifecycleStore,
  ) {}

  async discover(
    enqueuer: WorkspaceDeletionEnqueuer,
    {
      now,
      gracePeriodMs,
      staleAfterMs,
      limit,
    }: {
      now: Date;
      gracePeriodMs: number;
      staleAfterMs: number;
      limit: number;
    },
  ): Promise<{ recovered: number; admitted: number }> {
    const recovery = await this.lifecycleStore.findRecoveryCandidates(
      now,
      staleAfterMs,
      limit,
    );

    for (const candidate of recovery) {
      await this.enqueue(enqueuer, candidate.workspaceId);
    }

    const cutoff = new Date(now.getTime() - gracePeriodMs);
    const markerRows = await this.markerRepository
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
      .addOrderBy('workspace.id', 'ASC')
      .limit(limit)
      .getMany();

    let admitted = 0;

    for (const markerRow of markerRows) {
      const { workspace } = markerRow;
      const marker = markerRow.value as unknown as RegieE2eWorkspaceMarker;

      if (!this.isSafe(workspace.subdomain, marker)) {
        this.logger.warn(
          `Refusing to admit workspace ${workspace.id} to E2E deletion`,
        );
        continue;
      }

      const requested = await this.lifecycleStore.requestDeletion(
        workspace.id,
        WorkspaceDeletionKind.E2E,
        now,
      );

      if (requested === null) {
        continue;
      }

      await this.enqueue(enqueuer, workspace.id);
      admitted += 1;
    }

    return { recovered: recovery.length, admitted };
  }

  private enqueue(
    enqueuer: WorkspaceDeletionEnqueuer,
    workspaceId: string,
  ): Promise<void> {
    return enqueuer.enqueue({
      workspaceId,
      jobId: `workspace-delete:${workspaceId}`,
    });
  }

  private isSafe(
    subdomain: string,
    marker: RegieE2eWorkspaceMarker | null,
  ): boolean {
    return (
      marker?.ephemeral === true &&
      typeof marker.organizationId === 'string' &&
      marker.organizationId.startsWith(REGIE_E2E_ORGANIZATION_ID_PREFIX) &&
      marker.workspaceSlug === subdomain &&
      subdomain.startsWith(REGIE_E2E_WORKSPACE_SLUG_PREFIX)
    );
  }
}
