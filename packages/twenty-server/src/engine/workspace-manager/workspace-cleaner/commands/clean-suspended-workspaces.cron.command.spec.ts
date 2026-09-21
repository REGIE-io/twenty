import { type MessageQueueService } from 'src/engine/core-modules/message-queue/services/message-queue.service';
import { type TwentyConfigService } from 'src/engine/core-modules/twenty-config/twenty-config.service';
import { CleanSuspendedWorkspacesCronCommand } from 'src/engine/workspace-manager/workspace-cleaner/commands/clean-suspended-workspaces.cron.command';
import { CleanSuspendedWorkspacesJob } from 'src/engine/workspace-manager/workspace-cleaner/crons/clean-suspended-workspaces.job';

jest.mock(
  'src/engine/workspace-manager/workspace-cleaner/crons/clean-suspended-workspaces.job',
  () => ({
    CleanSuspendedWorkspacesJob: class CleanSuspendedWorkspacesJob {},
  }),
);

describe('CleanSuspendedWorkspacesCronCommand', () => {
  const makeCommand = (enabled: boolean) => {
    const queue = {
      addCron: jest.fn().mockResolvedValue(undefined),
      removeCron: jest.fn().mockResolvedValue(undefined),
    };
    const config = {
      get: jest.fn().mockReturnValue(enabled),
    };
    const command = new CleanSuspendedWorkspacesCronCommand(
      queue as unknown as MessageQueueService,
      config as unknown as TwentyConfigService,
    );

    return { command, config, queue };
  };

  it('removes the persisted scheduler instead of registering it when disabled', async () => {
    const { command, queue } = makeCommand(false);

    await command.run();

    expect(queue.removeCron).toHaveBeenCalledWith({
      jobName: CleanSuspendedWorkspacesJob.name,
    });
    expect(queue.addCron).not.toHaveBeenCalled();
  });

  it('retains the existing hourly registration behavior when enabled', async () => {
    const { command, queue } = makeCommand(true);

    await command.run();

    expect(queue.removeCron).not.toHaveBeenCalled();
    expect(queue.addCron).toHaveBeenCalledWith({
      jobName: CleanSuspendedWorkspacesJob.name,
      data: undefined,
      options: { repeat: { pattern: '0 * * * *' } },
    });
  });
});
