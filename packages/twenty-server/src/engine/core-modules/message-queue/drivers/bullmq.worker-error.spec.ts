import { Logger } from '@nestjs/common';

import { EventEmitter } from 'events';

import { Queue, Worker } from 'bullmq';

import { BullMQDriver } from 'src/engine/core-modules/message-queue/drivers/bullmq.driver';
import { MessageQueue } from 'src/engine/core-modules/message-queue/message-queue.constants';
import { type MetricsService } from 'src/engine/core-modules/metrics/metrics.service';
import { type TwentyConfigService } from 'src/engine/core-modules/twenty-config/twenty-config.service';

jest.mock('bullmq', () => ({
  MetricsTime: { ONE_WEEK: 604_800_000 },
  Queue: jest.fn(),
  Worker: jest.fn(),
}));

describe('BullMQ worker errors', () => {
  it('logs a worker error at error level instead of leaving it unhandled', () => {
    const worker = new EventEmitter();
    const errorLog = jest
      .spyOn(Logger.prototype, 'error')
      .mockImplementation(() => undefined);

    jest.mocked(Queue).mockImplementation(() => ({}) as never);
    jest.mocked(Worker).mockImplementation(() => worker as never);

    const driver = new BullMQDriver(
      {} as never,
      {
        createMultiObservableGauge: jest.fn(),
      } as unknown as MetricsService,
      { get: jest.fn() } as unknown as TwentyConfigService,
    );

    driver.register(MessageQueue.cronQueue);
    driver.work(MessageQueue.cronQueue, jest.fn());

    const connectionError = new Error('read ECONNRESET');

    expect(() => worker.emit('error', connectionError)).not.toThrow();
    expect(errorLog).toHaveBeenCalledWith(
      'Worker error on queue cron-queue',
      connectionError,
    );
  });
});
