import { Queue, Worker } from 'bullmq';

import { BullMQDriver } from 'src/engine/core-modules/message-queue/drivers/bullmq.driver';
import { type QueueJobOptions } from 'src/engine/core-modules/message-queue/drivers/interfaces/job-options.interface';
import { type MessageQueueWorkerOptions } from 'src/engine/core-modules/message-queue/interfaces/message-queue-worker-options.interface';
import { MESSAGE_QUEUE_WORKER_CONFIG } from 'src/engine/core-modules/message-queue/message-queue-worker-config.constant';
import { MessageQueue } from 'src/engine/core-modules/message-queue/message-queue.constants';
import { type MetricsService } from 'src/engine/core-modules/metrics/metrics.service';
import { type TwentyConfigService } from 'src/engine/core-modules/twenty-config/twenty-config.service';

jest.mock('@sentry/node', () => ({
  withIsolationScope: jest.fn((callback) => callback()),
}));
jest.mock('bullmq', () => ({
  MetricsTime: { ONE_WEEK: 604_800_000 },
  Queue: jest.fn(),
  Worker: jest.fn(),
}));

describe('BullMQ workspace deletion guarantees', () => {
  const queueName = MessageQueue.workspaceCleanupQueue;

  const makeDriver = () => {
    const queue = {
      add: jest.fn().mockResolvedValue(undefined),
      close: jest.fn(),
      count: jest.fn(),
      getJobs: jest.fn().mockResolvedValue([]),
    };
    const worker = { on: jest.fn(), close: jest.fn() };

    jest.mocked(Queue).mockImplementation(() => queue as never);
    jest.mocked(Worker).mockImplementation(() => worker as never);

    const driver = new BullMQDriver(
      {} as never,
      {
        createMultiObservableGauge: jest.fn(),
        recordHistogram: jest.fn(),
        incrementCounterForEvent: jest.fn(),
      } as unknown as MetricsService,
      { get: jest.fn() } as unknown as TwentyConfigService,
    );

    driver.register(queueName);

    return { driver, queue, worker };
  };

  beforeEach(() => jest.clearAllMocks());

  it('does not enqueue a duplicate while the same logical workspace job is active or delayed', async () => {
    const { driver, queue } = makeDriver();
    const existingJob = {
      id: 'workspace-delete-workspace-id-00000000-0000-4000-8000-000000000001',
    };

    queue.getJobs.mockImplementation(async (statuses: string[]) =>
      statuses.includes('active') || statuses.includes('delayed')
        ? [existingJob]
        : [],
    );

    await driver.add(
      queueName,
      'WorkspaceDeletionJob',
      { workspaceId: 'workspace-id' },
      { id: 'workspace-delete-workspace-id' },
    );

    expect(queue.getJobs).toHaveBeenCalledWith(
      expect.arrayContaining(['active', 'waiting', 'prioritized', 'delayed']),
    );
    expect(queue.add).not.toHaveBeenCalled();
  });

  it('passes exponential backoff and jitter to BullMQ', async () => {
    const { driver, queue } = makeDriver();
    const options = {
      id: 'workspace-delete-workspace-id',
      retryLimit: 2,
      retryBackoff: { type: 'exponential', delay: 5_000, jitter: 0.25 },
    } as QueueJobOptions & {
      retryBackoff: { type: string; delay: number; jitter: number };
    };

    await driver.add(
      queueName,
      'WorkspaceDeletionJob',
      { workspaceId: 'workspace-id' },
      options,
    );

    expect(queue.add).toHaveBeenCalledWith(
      'WorkspaceDeletionJob',
      { workspaceId: 'workspace-id' },
      expect.objectContaining({
        attempts: 3,
        backoff: { type: 'exponential', delay: 5_000, jitter: 0.25 },
      }),
    );
  });

  it('passes an explicit lock-renewal interval to a single-concurrency cleanup worker', () => {
    const { driver } = makeDriver();
    const options = {
      concurrency: 1,
      lockDuration: 30_000,
      lockRenewTime: 10_000,
      maxStalledCount: 1,
      boundedShutdownDrain: false,
    } as MessageQueueWorkerOptions & { lockRenewTime: number };

    driver.work(queueName, jest.fn(), options);

    expect(Worker).toHaveBeenCalledWith(
      queueName,
      expect.any(Function),
      expect.objectContaining({
        concurrency: 1,
        lockDuration: 30_000,
        lockRenewTime: 10_000,
        maxStalledCount: 1,
      }),
    );
    expect(MESSAGE_QUEUE_WORKER_CONFIG[queueName].workerOptions).toMatchObject({
      concurrency: 1,
      lockDuration: 30_000,
      lockRenewTime: 10_000,
      maxStalledCount: 1,
    });
  });
});
