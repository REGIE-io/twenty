import { WorkspaceActivationStatus } from 'twenty-shared/workspace';

import {
  WorkspaceDeletionKind,
  WorkspaceDeletionPhase,
} from 'src/engine/core-modules/workspace/types/workspace-deletion-lifecycle.type';
import { type WorkspaceDeletionLifecycleStore } from 'src/engine/workspace-manager/workspace-cleaner/services/workspace-deletion-lifecycle.store';
import { WorkspaceDeletionMonitoringService } from 'src/engine/workspace-manager/workspace-cleaner/services/workspace-deletion-monitoring.service';

describe('WorkspaceDeletionMonitoringService', () => {
  it('produces actionable rows and a summary without persisting another lifecycle', async () => {
    const now = new Date('2026-09-12T12:00:00.000Z');
    const store = {
      findOutstandingDeletions: jest.fn().mockResolvedValue([
        {
          workspaceId: 'pending-id',
          activationStatus: WorkspaceActivationStatus.PENDING_DELETION,
          deletionKind: WorkspaceDeletionKind.E2E,
          deletionPhase: WorkspaceDeletionPhase.MEMBERS,
          deletionRequestedAt: new Date('2026-09-12T11:55:00.000Z'),
          deletionLastProgressAt: new Date('2026-09-12T11:55:00.000Z'),
          deletionAttemptCount: 0,
          deletionLastErrorCode: null,
          deletionLastErrorMessage: null,
        },
        {
          workspaceId: 'stalled-id',
          activationStatus: WorkspaceActivationStatus.ONGOING_DELETION,
          deletionKind: WorkspaceDeletionKind.E2E,
          deletionPhase: WorkspaceDeletionPhase.SCHEMA,
          deletionRequestedAt: new Date('2026-09-12T11:40:00.000Z'),
          deletionLastProgressAt: new Date('2026-09-12T11:58:00.000Z'),
          deletionAttemptCount: 2,
          deletionLastErrorCode: 'QUERY_TIMEOUT',
          deletionLastErrorMessage: 'schema timed out',
        },
        {
          workspaceId: 'retryable-id',
          activationStatus: WorkspaceActivationStatus.ONGOING_DELETION,
          deletionKind: WorkspaceDeletionKind.E2E,
          deletionPhase: WorkspaceDeletionPhase.CACHE,
          deletionRequestedAt: new Date('2026-09-12T11:45:00.000Z'),
          deletionLastProgressAt: new Date('2026-09-12T11:59:00.000Z'),
          deletionAttemptCount: 1,
          deletionLastErrorCode: 'REDIS_TIMEOUT',
          deletionLastErrorMessage: 'cache unavailable',
        },
        {
          workspaceId: 'failed-id',
          activationStatus: WorkspaceActivationStatus.DELETION_FAILED,
          deletionKind: WorkspaceDeletionKind.E2E,
          deletionPhase: WorkspaceDeletionPhase.EXTERNAL_CLEANUP,
          deletionRequestedAt: new Date('2026-09-12T11:30:00.000Z'),
          deletionLastProgressAt: new Date('2026-09-12T11:50:00.000Z'),
          deletionAttemptCount: 3,
          deletionLastErrorCode: 'DNS_TIMEOUT',
          deletionLastErrorMessage: 'DNS provider unavailable',
        },
      ]),
    } as unknown as WorkspaceDeletionLifecycleStore;
    const service = new WorkspaceDeletionMonitoringService(store);

    const report = await service.report(now, 120_000);

    expect(report.rows).toEqual([
      expect.objectContaining({
        workspaceId: 'pending-id',
        state: 'pending',
        ageMs: 300_000,
      }),
      expect.objectContaining({
        workspaceId: 'stalled-id',
        state: 'stalled',
        ageMs: 1_200_000,
      }),
      expect.objectContaining({
        workspaceId: 'retryable-id',
        state: 'retryable-failure',
        ageMs: 900_000,
      }),
      expect.objectContaining({
        workspaceId: 'failed-id',
        state: 'terminal-failure',
        ageMs: 1_800_000,
      }),
    ]);
    expect(report.summary).toEqual({
      outstanding: 4,
      pending: 1,
      running: 0,
      stalled: 1,
      retryableFailures: 1,
      terminalFailures: 1,
      oldestAgeMs: 1_800_000,
    });
  });
});
