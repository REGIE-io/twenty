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
import { MetricsService } from 'src/engine/core-modules/metrics/metrics.service';
import { MetricsKeys } from 'src/engine/core-modules/metrics/types/metrics-keys.type';
import { WorkspaceDeletionKind } from 'src/engine/core-modules/workspace/types/workspace-deletion-lifecycle.type';
import { WorkspaceDeletionLifecycleStore } from 'src/engine/workspace-manager/workspace-cleaner/services/workspace-deletion-lifecycle.store';
import { WorkspaceDeletionTraceService } from 'src/engine/workspace-manager/workspace-cleaner/services/workspace-deletion-trace.service';

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
    private readonly trace: WorkspaceDeletionTraceService,
    private readonly metrics: MetricsService,
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
    this.trace.record({
      event: 'workspace_deletion_discovery_started',
      deletionKind: WorkspaceDeletionKind.E2E,
    });

    try {
      const result = await this.discoverCandidates(enqueuer, {
        now,
        gracePeriodMs,
        staleAfterMs,
        limit,
      });
      const attributes = { deletionKind: WorkspaceDeletionKind.E2E };

      this.metrics.incrementCounterBy({
        key: MetricsKeys.WorkspaceDeletionDiscoveryCandidates,
        amount: result.candidates,
        attributes,
      });
      this.metrics.incrementCounterBy({
        key: MetricsKeys.WorkspaceDeletionRecovered,
        amount: result.recovered,
        attributes,
      });
      this.metrics.incrementCounterBy({
        key: MetricsKeys.WorkspaceDeletionAdmitted,
        amount: result.admitted,
        attributes,
      });
      this.trace.record({
        event: 'workspace_deletion_discovery_finished',
        deletionKind: WorkspaceDeletionKind.E2E,
        ...result,
      });

      return { recovered: result.recovered, admitted: result.admitted };
    } catch (error) {
      const errorCode = this.errorCode(error);

      this.trace.record({
        event: 'workspace_deletion_discovery_failed',
        deletionKind: WorkspaceDeletionKind.E2E,
        errorCode,
        errorMessage: this.errorMessage(error),
      });
      void this.metrics.incrementCounterForEvent({
        key: MetricsKeys.WorkspaceDeletionDiscoveryFailed,
        attributes: {
          deletionKind: WorkspaceDeletionKind.E2E,
          errorCode,
        },
        shouldStoreInCache: false,
      });

      throw error;
    }
  }

  private async discoverCandidates(
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
  ): Promise<{ candidates: number; recovered: number; admitted: number }> {
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

    return {
      candidates: markerRows.length,
      recovered: recovery.length,
      admitted,
    };
  }

  private errorCode(error: unknown): string {
    if (
      typeof error === 'object' &&
      error !== null &&
      'code' in error &&
      typeof error.code === 'string'
    ) {
      return error.code;
    }

    return error instanceof Error && error.name
      ? error.name.toUpperCase()
      : 'UNKNOWN_ERROR';
  }

  private errorMessage(error: unknown): string {
    return error instanceof Error ? error.message : String(error);
  }

  private enqueue(
    enqueuer: WorkspaceDeletionEnqueuer,
    workspaceId: string,
  ): Promise<void> {
    return enqueuer.enqueue({
      workspaceId,
      jobId: `workspace-delete-${workspaceId}`,
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
