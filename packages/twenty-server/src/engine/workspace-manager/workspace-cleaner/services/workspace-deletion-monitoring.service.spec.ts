import { WorkspaceActivationStatus } from 'twenty-shared/workspace';

import {
  WorkspaceDeletionKind,
  WorkspaceDeletionPhase,
} from 'src/engine/core-modules/workspace/types/workspace-deletion-lifecycle.type';
import { type MetricsService } from 'src/engine/core-modules/metrics/metrics.service';
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

  it('publishes backlog and oldest-age alarm inputs without workspace IDs as dimensions', async () => {
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
          workspaceId: 'failed-id',
          activationStatus: WorkspaceActivationStatus.DELETION_FAILED,
          deletionKind: WorkspaceDeletionKind.E2E,
          deletionPhase: WorkspaceDeletionPhase.SCHEMA,
          deletionRequestedAt: new Date('2026-09-12T11:30:00.000Z'),
          deletionLastProgressAt: new Date('2026-09-12T11:50:00.000Z'),
          deletionAttemptCount: 3,
          deletionLastErrorCode: '55P03',
          deletionLastErrorMessage: 'schema lock timeout',
        },
      ]),
    } as unknown as WorkspaceDeletionLifecycleStore;
    const callbacks = new Map<string, () => unknown>();
    const metrics = {
      createMultiObservableGauge: jest.fn(({ metricName, callback }) => {
        callbacks.set(metricName, callback);
      }),
      createObservableGauge: jest.fn(({ metricName, callback }) => {
        callbacks.set(metricName, callback);
      }),
    } as unknown as MetricsService;
    const service = Reflect.construct(WorkspaceDeletionMonitoringService, [
      store,
      metrics,
    ]) as WorkspaceDeletionMonitoringService & {
      registerMetrics(options: { now: () => Date; staleAfterMs: number }): void;
    };

    service.registerMetrics({ now: () => now, staleAfterMs: 120_000 });

    expect(metrics.createMultiObservableGauge).toHaveBeenCalledWith(
      expect.objectContaining({
        metricName: 'workspace-deletion/backlog',
        cacheValue: false,
      }),
    );
    expect(metrics.createObservableGauge).toHaveBeenCalledWith(
      expect.objectContaining({
        metricName: 'workspace-deletion/oldest-age-ms',
        cacheValue: false,
      }),
    );

    const backlog = await callbacks.get('workspace-deletion/backlog')?.();
    const oldestAge = await callbacks.get(
      'workspace-deletion/oldest-age-ms',
    )?.();

    expect(backlog).toEqual(
      expect.arrayContaining([
        {
          value: 1,
          attributes: { deletionKind: 'E2E', state: 'pending' },
        },
        {
          value: 1,
          attributes: { deletionKind: 'E2E', state: 'terminal-failure' },
        },
      ]),
    );
    expect(JSON.stringify(backlog)).not.toContain('pending-id');
    expect(JSON.stringify(backlog)).not.toContain('failed-id');
    expect(oldestAge).toBe(1_800_000);
  });
});
