import {
  BadRequestException,
  ConflictException,
  Injectable,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';

import { WorkspaceActivationStatus } from 'twenty-shared/workspace';
import { Repository } from 'typeorm';

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
import { WorkspaceEntity } from 'src/engine/core-modules/workspace/workspace.entity';
import {
  type WorkspaceDeletionLifecycle,
  WorkspaceDeletionKind,
} from 'src/engine/core-modules/workspace/types/workspace-deletion-lifecycle.type';
import { type InternalWorkspaceInstantHardDeletionDto } from 'src/engine/workspace-manager/workspace-cleaner/dtos/internal-workspace-instant-hard-deletion.dto';
import { WorkspaceDeletionLifecycleStore } from 'src/engine/workspace-manager/workspace-cleaner/services/workspace-deletion-lifecycle.store';
import { WorkspaceDeletionQueueAdapter } from 'src/engine/workspace-manager/workspace-cleaner/services/workspace-deletion-queue.adapter';

@Injectable()
export class InternalWorkspaceInstantHardDeletionService {
  constructor(
    @InjectRepository(WorkspaceEntity)
    private readonly workspaceRepository: Repository<WorkspaceEntity>,
    @InjectRepository(KeyValuePairEntity)
    private readonly markerRepository: Repository<KeyValuePairEntity>,
    private readonly lifecycleStore: WorkspaceDeletionLifecycleStore,
    private readonly queue: WorkspaceDeletionQueueAdapter,
  ) {}

  async request(
    workspaceId: string,
    input: InternalWorkspaceInstantHardDeletionDto,
  ) {
    const workspace = await this.findWorkspace(workspaceId);

    if (workspace === null) {
      return this.completedResponse(workspaceId);
    }

    await this.assertSafetyIdentity(workspace, input);

    let lifecycle = await this.lifecycleStore.requestInstantHardDeletion(
      workspaceId,
      WorkspaceDeletionKind.E2E,
      new Date(),
    );

    if (lifecycle === null) {
      const current = await this.findWorkspace(workspaceId);

      if (current === null) {
        return this.completedResponse(workspaceId);
      }
      if (current.deletionKind !== WorkspaceDeletionKind.E2E) {
        throw new ConflictException(
          'Workspace has a different deletion operation',
        );
      }
      if (!this.isDeletionLifecycle(current.activationStatus)) {
        throw new ConflictException(
          'Workspace cannot enter instant hard deletion from its current state',
        );
      }
      lifecycle = this.toLifecycle(current);
    }

    if (
      lifecycle.activationStatus === WorkspaceActivationStatus.PENDING_DELETION
    ) {
      await this.queue.enqueue({
        workspaceId,
        jobId: `workspace-delete:${workspaceId}`,
      });
    }

    return this.lifecycleResponse(lifecycle);
  }

  private findWorkspace(workspaceId: string): Promise<WorkspaceEntity | null> {
    return this.workspaceRepository.findOne({
      where: { id: workspaceId },
      withDeleted: true,
    });
  }

  private async assertSafetyIdentity(
    workspace: WorkspaceEntity,
    input: InternalWorkspaceInstantHardDeletionDto,
  ): Promise<void> {
    const markerRow = await this.markerRepository.findOne({
      where: {
        workspaceId: workspace.id,
        key: REGIE_E2E_WORKSPACE_MARKER_KEY,
        type: KeyValuePairType.USER_VARIABLE,
      },
    });
    const marker = markerRow?.value as unknown as
      | RegieE2eWorkspaceMarker
      | undefined;
    const valid =
      input.organizationId.startsWith(REGIE_E2E_ORGANIZATION_ID_PREFIX) &&
      input.workspaceSlug.startsWith(REGIE_E2E_WORKSPACE_SLUG_PREFIX) &&
      workspace.subdomain === input.workspaceSlug &&
      marker?.ephemeral === true &&
      marker.organizationId === input.organizationId &&
      marker.workspaceSlug === input.workspaceSlug;

    if (!valid) {
      throw new BadRequestException(
        'Instant hard deletion requires an exact persistent E2E identity match',
      );
    }
  }

  private isDeletionLifecycle(status: WorkspaceActivationStatus): boolean {
    return [
      WorkspaceActivationStatus.PENDING_DELETION,
      WorkspaceActivationStatus.ONGOING_DELETION,
      WorkspaceActivationStatus.DELETION_FAILED,
    ].includes(status);
  }

  private toLifecycle(workspace: WorkspaceEntity): WorkspaceDeletionLifecycle {
    return {
      workspaceId: workspace.id,
      activationStatus: workspace.activationStatus,
      deletionKind: workspace.deletionKind,
      deletionPhase: workspace.deletionPhase,
      deletionRequestedAt: workspace.deletionRequestedAt,
      deletionLastProgressAt: workspace.deletionLastProgressAt,
      deletionAttemptCount: workspace.deletionAttemptCount,
      deletionLastErrorCode: workspace.deletionLastErrorCode,
      deletionLastErrorMessage: workspace.deletionLastErrorMessage,
    };
  }

  private lifecycleResponse(lifecycle: WorkspaceDeletionLifecycle) {
    return {
      operation: 'instant-hard-deletion' as const,
      workspaceId: lifecycle.workspaceId,
      status: lifecycle.activationStatus,
      phase: lifecycle.deletionPhase,
      attemptCount: lifecycle.deletionAttemptCount,
      lastProgressAt: lifecycle.deletionLastProgressAt?.toISOString() ?? null,
      errorCode: lifecycle.deletionLastErrorCode,
      completed: false,
    };
  }

  private completedResponse(workspaceId: string) {
    return {
      operation: 'instant-hard-deletion' as const,
      workspaceId,
      status: 'COMPLETED' as const,
      phase: null,
      attemptCount: 0,
      lastProgressAt: null,
      errorCode: null,
      completed: true,
    };
  }
}
