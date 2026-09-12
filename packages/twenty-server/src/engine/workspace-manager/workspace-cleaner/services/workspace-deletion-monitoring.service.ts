import { Injectable } from '@nestjs/common';

import { WorkspaceActivationStatus } from 'twenty-shared/workspace';

import { type WorkspaceDeletionLifecycle } from 'src/engine/core-modules/workspace/types/workspace-deletion-lifecycle.type';
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
export class WorkspaceDeletionMonitoringService {
  constructor(
    private readonly lifecycleStore: WorkspaceDeletionLifecycleStore,
  ) {}

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
