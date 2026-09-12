import {
  REGIE_E2E_PURGE_BATCH_SIZE,
  REGIE_E2E_PURGE_GRACE_PERIOD_MS,
} from 'src/engine/core-modules/auth/constants/regie-e2e-workspace-marker.constant';
import { RegieE2eWorkspaceDeletionDiscoveryJob } from 'src/engine/workspace-manager/workspace-cleaner/crons/regie-e2e-workspace-deletion-discovery.job';
import { type RegieE2eWorkspaceDeletionDiscoveryService } from 'src/engine/workspace-manager/workspace-cleaner/services/regie-e2e-workspace-deletion-discovery.service';
import { type WorkspaceDeletionQueueAdapter } from 'src/engine/workspace-manager/workspace-cleaner/services/workspace-deletion-queue.adapter';

describe('RegieE2eWorkspaceDeletionDiscoveryJob', () => {
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
});
