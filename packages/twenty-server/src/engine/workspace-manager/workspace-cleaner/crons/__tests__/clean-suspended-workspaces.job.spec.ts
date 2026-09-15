import { type MessageQueueService } from 'src/engine/core-modules/message-queue/services/message-queue.service';
import { CleanSuspendedWorkspacesJob } from 'src/engine/workspace-manager/workspace-cleaner/crons/clean-suspended-workspaces.job';
import { CleanSuspendedWorkspacesBatchJob } from 'src/engine/workspace-manager/workspace-cleaner/jobs/clean-suspended-workspaces-batch.job';

jest.mock(
  'src/engine/workspace-manager/workspace-cleaner/jobs/clean-suspended-workspaces-batch.job',
  () => ({
    CleanSuspendedWorkspacesBatchJob: class {},
  }),
);

describe('CleanSuspendedWorkspacesJob', () => {
  const messageQueueService = {
    add: jest.fn(),
  };

  const createJob = () =>
    new CleanSuspendedWorkspacesJob(
      messageQueueService as unknown as MessageQueueService,
    );

  beforeEach(() => {
    jest.clearAllMocks();
    messageQueueService.add.mockResolvedValue(undefined);
  });

  it('enqueues suspended workspace cleanup outside the cron queue', async () => {
    await createJob().handle();

    expect(messageQueueService.add).toHaveBeenCalledWith(
      CleanSuspendedWorkspacesBatchJob.name,
      {},
    );
  });
});
