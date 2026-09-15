import { type MessageQueueService } from 'src/engine/core-modules/message-queue/services/message-queue.service';
import { type TwentyConfigService } from 'src/engine/core-modules/twenty-config/twenty-config.service';
import { RegieE2eWorkspaceDeletionDiscoveryJob } from 'src/engine/workspace-manager/workspace-cleaner/crons/regie-e2e-workspace-deletion-discovery.job';
import { CronRegistrationService } from 'src/modules/cron-registration/cron-registration.service';

describe('CronRegistrationService', () => {
  const makeService = (e2eDeletionEnabled: boolean) => {
    const queue = {
      addCron: jest.fn().mockResolvedValue(undefined),
      removeCron: jest.fn().mockResolvedValue(undefined),
    };
    const config = {
      get: jest.fn((key: string) =>
        key === 'REGIE_E2E_WORKSPACE_DELETION_CRON_ENABLED'
          ? e2eDeletionEnabled
          : true,
      ),
    };
    const service = new CronRegistrationService(
      queue as unknown as MessageQueueService,
      config as unknown as TwentyConfigService,
    );

    return { config, queue, service };
  };

  it('removes the E2E deletion scheduler while its rollout switch is disabled', async () => {
    const { queue, service } = makeService(false);

    await service.onApplicationBootstrap();

    expect(queue.removeCron).toHaveBeenCalledWith({
      jobName: RegieE2eWorkspaceDeletionDiscoveryJob.name,
    });
    expect(queue.addCron).not.toHaveBeenCalledWith(
      expect.objectContaining({
        jobName: RegieE2eWorkspaceDeletionDiscoveryJob.name,
      }),
    );
  });

  it('self-registers E2E discovery every ten minutes when enabled', async () => {
    const { queue, service } = makeService(true);

    await service.onApplicationBootstrap();

    expect(queue.addCron).toHaveBeenCalledWith({
      jobName: RegieE2eWorkspaceDeletionDiscoveryJob.name,
      data: undefined,
      options: { repeat: { pattern: '*/10 * * * *' } },
    });
    expect(queue.removeCron).not.toHaveBeenCalledWith({
      jobName: RegieE2eWorkspaceDeletionDiscoveryJob.name,
    });
  });
});
