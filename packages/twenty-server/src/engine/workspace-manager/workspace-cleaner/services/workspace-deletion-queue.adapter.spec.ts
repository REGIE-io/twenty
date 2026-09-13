import { type MessageQueueService } from 'src/engine/core-modules/message-queue/services/message-queue.service';
import { WorkspaceDeletionJob } from 'src/engine/workspace-manager/workspace-cleaner/jobs/workspace-deletion.job';
import { WorkspaceDeletionQueueAdapter } from 'src/engine/workspace-manager/workspace-cleaner/services/workspace-deletion-queue.adapter';

describe('WorkspaceDeletionQueueAdapter', () => {
  it('preserves the logical workspace identity and bounded retry budget', async () => {
    const queue = { add: jest.fn().mockResolvedValue(undefined) };
    const adapter = new WorkspaceDeletionQueueAdapter(
      queue as unknown as MessageQueueService,
    );

    await adapter.enqueue({
      workspaceId: 'workspace-id',
      jobId: 'workspace-delete-workspace-id',
    });

    expect(queue.add).toHaveBeenCalledWith(
      WorkspaceDeletionJob.name,
      { workspaceId: 'workspace-id' },
      {
        id: 'workspace-delete-workspace-id',
        retryLimit: 2,
        retryBackoff: {
          type: 'exponential',
          delay: 5_000,
          jitter: 0.25,
        },
      },
    );
  });
});
