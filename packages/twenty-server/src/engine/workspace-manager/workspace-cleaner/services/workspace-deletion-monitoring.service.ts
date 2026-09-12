import { Injectable, type OnModuleInit } from '@nestjs/common';

import { WorkspaceActivationStatus } from 'twenty-shared/workspace';

import { type WorkspaceDeletionLifecycle } from 'src/engine/core-modules/workspace/types/workspace-deletion-lifecycle.type';
import { MetricsService } from 'src/engine/core-modules/metrics/metrics.service';
import { WorkspaceDeletionLifecycleStore } from 'src/engine/workspace-manager/workspace-cleaner/services/workspace-deletion-lifecycle.store';

export type WorkspaceDeletionMonitoringState =
  | 'pending'
  | 'running'
  | 'retryable-failure'
  | 'stalled'
  | 'terminal-failure';

export type WorkspaceDeletionMonitoringRow = WorkspaceDeletionLifecycle & {
  state: WorkspaceDeletionMonitoringState;
  ageMs: number;
  idleMs: number;
};

@Injectable()
export class WorkspaceDeletionMonitoringService implements OnModuleInit {
  constructor(
    private readonly lifecycleStore: WorkspaceDeletionLifecycleStore,
    private readonly metrics?: MetricsService,
  ) {}

  onModuleInit(): void {
    this.registerMetrics({ now: () => new Date(), staleAfterMs: 30_000 });
  }

  registerMetrics({
    now,
    staleAfterMs,
  }: {
    now: () => Date;
    staleAfterMs: number;
  }): void {
    if (this.metrics === undefined) {
      return;
    }

    this.metrics.createMultiObservableGauge({
      metricName: 'workspace-deletion/backlog',
      options: {
        description:
          'Outstanding workspace deletions grouped by kind and lifecycle state',
      },
      callback: async () => {
        const { rows } = await this.report(now(), staleAfterMs);
        const counts = new Map<
          string,
          {
            deletionKind: string;
            state: WorkspaceDeletionMonitoringState;
            value: number;
          }
        >();

        for (const row of rows) {
          const deletionKind = row.deletionKind ?? 'UNKNOWN';
          const key = `${deletionKind}:${row.state}`;
          const current = counts.get(key);

          counts.set(key, {
            deletionKind,
            state: row.state,
            value: (current?.value ?? 0) + 1,
          });
        }

        return [...counts.values()].map(({ deletionKind, state, value }) => ({
          value,
          attributes: { deletionKind, state },
        }));
      },
      cacheValue: false,
    });
    this.metrics.createObservableGauge({
      metricName: 'workspace-deletion/oldest-age-ms',
      options: {
        description: 'Age in milliseconds of the oldest outstanding deletion',
      },
      callback: async () =>
        (await this.report(now(), staleAfterMs)).summary.oldestAgeMs,
      cacheValue: false,
    });
  }

  async report(now: Date, staleAfterMs: number) {
    const lifecycles = await this.lifecycleStore.findOutstandingDeletions();
    const rows = lifecycles.map((lifecycle) => ({
      ...lifecycle,
      state: this.state(lifecycle, now, staleAfterMs),
      ageMs: this.elapsed(now, lifecycle.deletionRequestedAt),
      idleMs: this.elapsed(now, lifecycle.deletionLastProgressAt),
    }));

    return {
      rows,
      summary: {
        outstanding: rows.length,
        pending: rows.filter(({ state }) => state === 'pending').length,
        running: rows.filter(({ state }) => state === 'running').length,
        stalled: rows.filter(({ state }) => state === 'stalled').length,
        retryableFailures: rows.filter(
          ({ state }) => state === 'retryable-failure',
        ).length,
        terminalFailures: rows.filter(
          ({ state }) => state === 'terminal-failure',
        ).length,
        oldestAgeMs: Math.max(0, ...rows.map(({ ageMs }) => ageMs)),
      },
    };
  }

  private state(
    lifecycle: WorkspaceDeletionLifecycle,
    now: Date,
    staleAfterMs: number,
  ): WorkspaceDeletionMonitoringState {
    if (
      lifecycle.activationStatus === WorkspaceActivationStatus.DELETION_FAILED
    ) {
      return 'terminal-failure';
    }
    if (
      lifecycle.activationStatus === WorkspaceActivationStatus.PENDING_DELETION
    ) {
      return 'pending';
    }
    if (this.elapsed(now, lifecycle.deletionLastProgressAt) >= staleAfterMs) {
      return 'stalled';
    }
    if (lifecycle.deletionLastErrorCode !== null) {
      return 'retryable-failure';
    }

    return 'running';
  }

  private elapsed(now: Date, from: Date | null): number {
    return from === null ? 0 : Math.max(0, now.getTime() - from.getTime());
  }
}
