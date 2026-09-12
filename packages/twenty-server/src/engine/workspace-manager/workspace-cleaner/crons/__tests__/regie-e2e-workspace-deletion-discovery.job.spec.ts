import * as Sentry from '@sentry/node';

import {
  REGIE_E2E_PURGE_BATCH_SIZE,
  REGIE_E2E_PURGE_GRACE_PERIOD_MS,
} from 'src/engine/core-modules/auth/constants/regie-e2e-workspace-marker.constant';
import { RegieE2eWorkspaceDeletionDiscoveryJob } from 'src/engine/workspace-manager/workspace-cleaner/crons/regie-e2e-workspace-deletion-discovery.job';
import { type RegieE2eWorkspaceDeletionDiscoveryService } from 'src/engine/workspace-manager/workspace-cleaner/services/regie-e2e-workspace-deletion-discovery.service';
import { type WorkspaceDeletionQueueAdapter } from 'src/engine/workspace-manager/workspace-cleaner/services/workspace-deletion-queue.adapter';

jest.mock('@sentry/node', () => ({
  captureCheckIn: jest.fn(),
  isInitialized: jest.fn().mockReturnValue(false),
}));

describe('RegieE2eWorkspaceDeletionDiscoveryJob', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    jest.mocked(Sentry.isInitialized).mockReturnValue(false);
    jest.mocked(Sentry.captureCheckIn).mockReturnValue('check-in-id');
  });

  it('runs recovery and fresh discovery together at the current grace boundary', async () => {
    const discovery = {
      discover: jest.fn().mockResolvedValue({ recovered: 2, admitted: 3 }),
    };
    const adapter = {};
    const now = new Date('2026-09-12T12:00:00.000Z');
    const job = new RegieE2eWorkspaceDeletionDiscoveryJob(
      discovery as unknown as RegieE2eWorkspaceDeletionDiscoveryService,
      adapter as WorkspaceDeletionQueueAdapter,
    );

    await expect(job.handle(now)).resolves.toEqual({
      recovered: 2,
      admitted: 3,
    });
    expect(discovery.discover).toHaveBeenCalledWith(adapter, {
      now,
      gracePeriodMs: REGIE_E2E_PURGE_GRACE_PERIOD_MS,
      staleAfterMs: 30_000,
      limit: REGIE_E2E_PURGE_BATCH_SIZE,
    });
  });

  it('keeps the Sentry check-in open until discovery itself completes', async () => {
    jest.mocked(Sentry.isInitialized).mockReturnValue(true);
    let finishDiscovery: (value: {
      recovered: number;
      admitted: number;
    }) => void;
    const discoveryResult = new Promise<{
      recovered: number;
      admitted: number;
    }>((resolve) => {
      finishDiscovery = resolve;
    });
    const discovery = { discover: jest.fn(() => discoveryResult) };
    const job = new RegieE2eWorkspaceDeletionDiscoveryJob(
      discovery as unknown as RegieE2eWorkspaceDeletionDiscoveryService,
      {} as WorkspaceDeletionQueueAdapter,
    );

    const handling = job.handle(new Date('2026-09-12T12:00:00.000Z'));

    expect(Sentry.captureCheckIn).toHaveBeenCalledTimes(1);
    expect(Sentry.captureCheckIn).toHaveBeenCalledWith(
      expect.objectContaining({ status: 'in_progress' }),
      expect.any(Object),
    );

    finishDiscovery!({ recovered: 2, admitted: 3 });
    await expect(handling).resolves.toEqual({ recovered: 2, admitted: 3 });

    expect(Sentry.captureCheckIn).toHaveBeenLastCalledWith({
      checkInId: 'check-in-id',
      monitorSlug: RegieE2eWorkspaceDeletionDiscoveryJob.name,
      status: 'ok',
    });
  });

  it('marks the discovery check-in failed when discovery rejects', async () => {
    jest.mocked(Sentry.isInitialized).mockReturnValue(true);
    const failure = new Error('marker query timed out');
    const discovery = { discover: jest.fn().mockRejectedValue(failure) };
    const job = new RegieE2eWorkspaceDeletionDiscoveryJob(
      discovery as unknown as RegieE2eWorkspaceDeletionDiscoveryService,
      {} as WorkspaceDeletionQueueAdapter,
    );

    await expect(job.handle()).rejects.toBe(failure);

    expect(Sentry.captureCheckIn).toHaveBeenLastCalledWith({
      checkInId: 'check-in-id',
      monitorSlug: RegieE2eWorkspaceDeletionDiscoveryJob.name,
      status: 'error',
    });
  });
});
