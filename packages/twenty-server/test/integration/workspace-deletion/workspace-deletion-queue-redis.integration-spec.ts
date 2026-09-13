import crypto from 'crypto';

import { Queue, Worker } from 'bullmq';

jest.useRealTimers();

describe('workspace deletion BullMQ lock renewal', () => {
  const connection = () => {
    const redisUrl = new URL(process.env.REDIS_URL ?? 'redis://localhost:6379');

    return {
      host: redisUrl.hostname,
      port: Number(redisUrl.port || 6379),
      username: redisUrl.username || undefined,
      password: redisUrl.password || undefined,
      ...(redisUrl.protocol === 'rediss:' ? { tls: {} } : {}),
    };
  };

  it('completes a job longer than its base lock without a stall or duplicate execution', async () => {
    const redisConnection = connection();
    const queueName = `workspace-deletion-lock-renewal-${crypto.randomUUID()}`;
    const queue = new Queue(queueName, { connection: redisConnection });
    let executions = 0;
    let stalls = 0;
    const worker = new Worker(
      queueName,
      async () => {
        executions += 1;
        await new Promise((resolve) => setTimeout(resolve, 1_500));
      },
      {
        connection: redisConnection,
        concurrency: 1,
        lockDuration: 500,
        lockRenewTime: 100,
        maxStalledCount: 1,
        stalledInterval: 100,
      },
    );

    worker.on('stalled', () => {
      stalls += 1;
    });

    try {
      await worker.waitUntilReady();
      const completed = new Promise<void>((resolve, reject) => {
        worker.once('completed', () => resolve());
        worker.once('failed', (_job, error) => reject(error));
      });

      await queue.add('WorkspaceDeletionJob', { workspaceId: 'fixture' });
      let timeout: ReturnType<typeof setTimeout> | undefined;

      try {
        await Promise.race([
          completed,
          new Promise((_, reject) => {
            timeout = setTimeout(
              () => reject(new Error('BullMQ job did not finish')),
              10_000,
            );
          }),
        ]);
      } finally {
        clearTimeout(timeout);
      }

      expect(executions).toBe(1);
      expect(stalls).toBe(0);
    } finally {
      await worker.close();
      await queue.obliterate({ force: true });
      await queue.close();
    }
  });

  it('reclaims and completes a job after its first worker disappears', async () => {
    const redisConnection = connection();
    const queueName = `workspace-deletion-worker-restart-${crypto.randomUUID()}`;
    const queue = new Queue(queueName, { connection: redisConnection });
    let firstExecutions = 0;
    let secondExecutions = 0;
    let firstStarted!: () => void;
    const started = new Promise<void>((resolve) => {
      firstStarted = resolve;
    });
    const firstWorker = new Worker(
      queueName,
      async () => {
        firstExecutions += 1;
        firstStarted();
        await new Promise(() => undefined);
      },
      {
        connection: redisConnection,
        lockDuration: 500,
        lockRenewTime: 100,
        stalledInterval: 100,
        maxStalledCount: 1,
      },
    );
    let secondWorker: Worker | undefined;

    try {
      await firstWorker.waitUntilReady();
      await queue.add('WorkspaceDeletionJob', { workspaceId: 'fixture' });
      await started;
      await firstWorker.close(true);

      secondWorker = new Worker(
        queueName,
        async () => {
          secondExecutions += 1;
        },
        {
          connection: redisConnection,
          lockDuration: 500,
          lockRenewTime: 100,
          stalledInterval: 100,
          maxStalledCount: 1,
        },
      );
      await secondWorker.waitUntilReady();
      const completed = new Promise<void>((resolve, reject) => {
        secondWorker?.once('completed', () => resolve());
        secondWorker?.once('failed', (_job, error) => reject(error));
      });
      let timeout: ReturnType<typeof setTimeout> | undefined;

      try {
        await Promise.race([
          completed,
          new Promise((_, reject) => {
            timeout = setTimeout(
              () => reject(new Error('Stalled BullMQ job was not reclaimed')),
              10_000,
            );
          }),
        ]);
      } finally {
        clearTimeout(timeout);
      }

      expect(firstExecutions).toBe(1);
      expect(secondExecutions).toBe(1);
    } finally {
      await firstWorker.close(true);
      await secondWorker?.close(true);
      await queue.obliterate({ force: true });
      await queue.close();
    }
  });
});
