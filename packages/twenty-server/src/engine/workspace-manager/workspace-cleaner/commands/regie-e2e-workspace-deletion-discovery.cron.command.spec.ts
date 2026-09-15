import { type MessageQueueService } from 'src/engine/core-modules/message-queue/services/message-queue.service';
import { RegieE2eWorkspaceDeletionDiscoveryCronCommand } from 'src/engine/workspace-manager/workspace-cleaner/commands/regie-e2e-workspace-deletion-discovery.cron.command';
import {
  REGIE_E2E_WORKSPACE_DELETION_CRON_PATTERN,
  RegieE2eWorkspaceDeletionDiscoveryJob,
} from 'src/engine/workspace-manager/workspace-cleaner/crons/regie-e2e-workspace-deletion-discovery.job';

describe('RegieE2eWorkspaceDeletionDiscoveryCronCommand', () => {
  it('registers independent discovery and recovery every ten minutes', async () => {
    const queue = { addCron: jest.fn().mockResolvedValue(undefined) };
    const command = new RegieE2eWorkspaceDeletionDiscoveryCronCommand(
      queue as unknown as MessageQueueService,
    );

    await command.run();

    expect(queue.addCron).toHaveBeenCalledWith({
      jobName: RegieE2eWorkspaceDeletionDiscoveryJob.name,
      data: undefined,
      options: {
        repeat: { pattern: REGIE_E2E_WORKSPACE_DELETION_CRON_PATTERN },
      },
    });
    expect(REGIE_E2E_WORKSPACE_DELETION_CRON_PATTERN).toBe('*/10 * * * *');
  });
});
