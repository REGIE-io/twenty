import { Injectable } from '@nestjs/common';

import { InjectMessageQueue } from 'src/engine/core-modules/message-queue/decorators/message-queue.decorator';
import { MessageQueue } from 'src/engine/core-modules/message-queue/message-queue.constants';
import { MessageQueueService } from 'src/engine/core-modules/message-queue/services/message-queue.service';
import { WorkspaceDeletionJob } from 'src/engine/workspace-manager/workspace-cleaner/jobs/workspace-deletion.job';
import { type WorkspaceDeletionEnqueuer } from 'src/engine/workspace-manager/workspace-cleaner/services/regie-e2e-workspace-deletion-discovery.service';

@Injectable()
export class WorkspaceDeletionQueueAdapter implements WorkspaceDeletionEnqueuer {
  constructor(
    @InjectMessageQueue(MessageQueue.workspaceCleanupQueue)
    private readonly queue: MessageQueueService,
  ) {}

  enqueue(input: { workspaceId: string; jobId: string }): Promise<void> {
    return this.queue.add(
      WorkspaceDeletionJob.name,
      { workspaceId: input.workspaceId },
      { id: input.jobId, retryLimit: 2 },
    );
  }
}
