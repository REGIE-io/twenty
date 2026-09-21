import { type MessageQueueService } from 'src/engine/core-modules/message-queue/services/message-queue.service';
import { type TwentyConfigService } from 'src/engine/core-modules/twenty-config/twenty-config.service';
import { RegieE2eWorkspaceDeletionDiscoveryJob } from 'src/engine/workspace-manager/workspace-cleaner/crons/regie-e2e-workspace-deletion-discovery.job';
import { CleanSuspendedWorkspacesJob } from 'src/engine/workspace-manager/workspace-cleaner/crons/clean-suspended-workspaces.job';
import { CronRegistrationService } from 'src/modules/cron-registration/cron-registration.service';

jest.mock(
  'src/engine/workspace-manager/workspace-cleaner/crons/clean-suspended-workspaces.job',
  () => ({
    CleanSuspendedWorkspacesJob: class CleanSuspendedWorkspacesJob {},
  }),
);

jest.mock(
  'src/engine/workspace-manager/workspace-cleaner/crons/regie-e2e-workspace-deletion-discovery.job',
  () => ({
    REGIE_E2E_WORKSPACE_DELETION_CRON_PATTERN: '*/10 * * * *',
    RegieE2eWorkspaceDeletionDiscoveryJob: class RegieE2eWorkspaceDeletionDiscoveryJob {},
  }),
);

describe('CronRegistrationService', () => {
  const makeService = ({
    e2eDeletionEnabled,
    legacyCleanupEnabled = true,
  }: {
    e2eDeletionEnabled: boolean;
    legacyCleanupEnabled?: boolean;
  }) => {
    const queue = {
      addCron: jest.fn().mockResolvedValue(undefined),
      removeCron: jest.fn().mockResolvedValue(undefined),
    };
    const config = {
      get: jest.fn((key: string) => {
        if (key === 'REGIE_E2E_WORKSPACE_DELETION_CRON_ENABLED') {
          return e2eDeletionEnabled;
        }

        if (key === 'CLEAN_SUSPENDED_WORKSPACES_CRON_ENABLED') {
          return legacyCleanupEnabled;
        }

        return true;
      }),
    };
    const service = new CronRegistrationService(
      queue as unknown as MessageQueueService,
      config as unknown as TwentyConfigService,
    );

    return { config, queue, service };
  };

  it('removes the E2E deletion scheduler while its rollout switch is disabled', async () => {
    const { queue, service } = makeService({ e2eDeletionEnabled: false });

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
    const { queue, service } = makeService({ e2eDeletionEnabled: true });

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

  it('removes the legacy suspended-workspace scheduler when disabled', async () => {
    const { queue, service } = makeService({
      e2eDeletionEnabled: false,
      legacyCleanupEnabled: false,
    });

    await service.onApplicationBootstrap();

    expect(queue.removeCron).toHaveBeenCalledWith({
      jobName: CleanSuspendedWorkspacesJob.name,
    });
    expect(queue.addCron).not.toHaveBeenCalledWith(
      expect.objectContaining({
        jobName: CleanSuspendedWorkspacesJob.name,
      }),
    );
  });
});
