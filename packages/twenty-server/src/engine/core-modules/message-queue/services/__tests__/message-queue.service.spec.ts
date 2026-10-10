import { type MessageQueueDriver } from 'src/engine/core-modules/message-queue/drivers/interfaces/message-queue-driver.interface';
import { MessageQueue } from 'src/engine/core-modules/message-queue/message-queue.constants';
import { MessageQueueService } from 'src/engine/core-modules/message-queue/services/message-queue.service';

const buildService = (disabledJobNames: string[]) => {
  const driver = {
    add: jest.fn().mockResolvedValue(undefined),
    bulkAdd: jest.fn().mockResolvedValue(undefined),
    addCron: jest.fn().mockResolvedValue(undefined),
    removeCron: jest.fn().mockResolvedValue(undefined),
    work: jest.fn(),
  };
  const service = new MessageQueueService(
    driver as unknown as MessageQueueDriver,
    MessageQueue.webhookQueue,
    new Set(disabledJobNames),
  );

  return { service, driver };
};

describe('MessageQueueService with disabled jobs', () => {
  it('does not queue a disabled job, alone or in bulk', async () => {
    const { service, driver } = buildService(['CallWebhookJobsJob']);

    await service.add('CallWebhookJobsJob', { workspaceId: 'workspace-id' });
    await service.bulkAdd('CallWebhookJobsJob', [
      { workspaceId: 'workspace-id' },
    ]);

    expect(driver.add).not.toHaveBeenCalled();
    expect(driver.bulkAdd).not.toHaveBeenCalled();
  });

  it('still queues every job that is not disabled', async () => {
    const { service, driver } = buildService(['CallWebhookJobsJob']);

    await service.add('CallMessageReceivedWebhookJob', {
      workspaceId: 'workspace-id',
    });

    expect(driver.add).toHaveBeenCalledWith(
      MessageQueue.webhookQueue,
      'CallMessageReceivedWebhookJob',
      { workspaceId: 'workspace-id' },
      undefined,
    );
  });

  it('removes the schedule of a disabled cron instead of registering it', async () => {
    const { service, driver } = buildService(['WorkflowCronTriggerCronJob']);

    await service.addCron({
      jobName: 'WorkflowCronTriggerCronJob',
      data: undefined,
      options: { repeat: { pattern: '* * * * *' } },
      jobId: 'workflow-cron-trigger',
    });

    expect(driver.addCron).not.toHaveBeenCalled();
    expect(driver.removeCron).toHaveBeenCalledWith({
      queueName: MessageQueue.webhookQueue,
      jobName: 'WorkflowCronTriggerCronJob',
      jobId: 'workflow-cron-trigger',
    });
  });

  it('queues everything when nothing is disabled', async () => {
    const { service, driver } = buildService([]);

    await service.add('CallWebhookJobsJob', { workspaceId: 'workspace-id' });
    await service.addCron({
      jobName: 'WorkflowCronTriggerCronJob',
      data: undefined,
      options: { repeat: { pattern: '* * * * *' } },
    });

    expect(driver.add).toHaveBeenCalledTimes(1);
    expect(driver.addCron).toHaveBeenCalledTimes(1);
    expect(driver.removeCron).not.toHaveBeenCalled();
  });
});
