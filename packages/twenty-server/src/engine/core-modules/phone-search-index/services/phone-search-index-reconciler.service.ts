import { Injectable } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import { type DataSource } from 'typeorm';

import { InjectMessageQueue } from 'src/engine/core-modules/message-queue/decorators/message-queue.decorator';
import { MessageQueue } from 'src/engine/core-modules/message-queue/message-queue.constants';
import { MessageQueueService } from 'src/engine/core-modules/message-queue/services/message-queue.service';
import { PhoneSearchIndexJob } from 'src/engine/core-modules/phone-search-index/jobs/phone-search-index.job';

/** Database rows, not Redis, are the source of truth for unfinished work. */
@Injectable()
export class PhoneSearchIndexReconcilerService {
  constructor(
    @InjectDataSource() private readonly dataSource: DataSource,
    @InjectMessageQueue(MessageQueue.phoneSearchIndexQueue)
    private readonly queue: MessageQueueService,
  ) {}

  async reconcile(): Promise<number> {
    const operations = await this.dataSource.query<Array<{ id: string }>>(
      `SELECT id FROM core."phoneSearchIndexOperation"
       WHERE status IN ('PENDING', 'RETRYABLE')
          OR (status = 'RUNNING' AND ("leaseExpiresAt" IS NULL OR "leaseExpiresAt" < now()))
       ORDER BY "updatedAt" ASC LIMIT 100`,
    );
    await Promise.all(
      operations.map(({ id: operationId }) =>
        this.queue.add(PhoneSearchIndexJob.name, { operationId }),
      ),
    );
    return operations.length;
  }
}
