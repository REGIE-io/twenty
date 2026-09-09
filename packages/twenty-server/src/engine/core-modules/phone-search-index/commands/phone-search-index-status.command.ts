import { InjectDataSource } from '@nestjs/typeorm';
import { Command, CommandRunner, Option } from 'nest-commander';
import { DataSource } from 'typeorm';

import { InjectMessageQueue } from 'src/engine/core-modules/message-queue/decorators/message-queue.decorator';
import { MessageQueue } from 'src/engine/core-modules/message-queue/message-queue.constants';
import { MessageQueueService } from 'src/engine/core-modules/message-queue/services/message-queue.service';

type PhoneSearchIndexStatusOptions = {
  failOnUnhealthy?: boolean;
  wait?: boolean;
  timeoutSeconds?: number;
  pollIntervalSeconds?: number;
};

type PhoneSearchIndexStatus = {
  expectedFieldCount: number;
  missingFieldStateCount: number;
  unhealthyFieldStateCount: number;
  activeOperationCount: number;
  failedOperationCount: number;
  queueDepth: number;
};

const DEFAULT_TIMEOUT_SECONDS = 3600;
const DEFAULT_POLL_INTERVAL_SECONDS = 15;

@Command({
  name: 'phone-search:index:status',
  description:
    'Report whether every provisioned Person phone field has converged and every index operation has completed',
})
export class PhoneSearchIndexStatusCommand extends CommandRunner {
  constructor(
    @InjectDataSource() private readonly dataSource: DataSource,
    @InjectMessageQueue(MessageQueue.phoneSearchIndexQueue)
    private readonly queue: MessageQueueService,
  ) {
    super();
  }

  @Option({
    flags: '--fail-on-unhealthy',
    description: 'Exit non-zero when phone-search state is missing or failed',
  })
  parseFailOnUnhealthy(): boolean {
    return true;
  }

  @Option({
    flags: '--wait',
    description: 'Wait for active index operations to complete',
  })
  parseWait(): boolean {
    return true;
  }

  @Option({
    flags: '--timeout-seconds <seconds>',
    description: 'Maximum time to wait for active operations',
  })
  parseTimeoutSeconds(value: string): number {
    return this.parsePositiveInteger(value, '--timeout-seconds');
  }

  @Option({
    flags: '--poll-interval-seconds <seconds>',
    description: 'Delay between status checks while waiting',
  })
  parsePollIntervalSeconds(value: string): number {
    return this.parsePositiveInteger(value, '--poll-interval-seconds');
  }

  override async run(
    _passedParams: string[],
    options: PhoneSearchIndexStatusOptions,
  ): Promise<void> {
    const timeoutSeconds = options.timeoutSeconds ?? DEFAULT_TIMEOUT_SECONDS;
    const pollIntervalSeconds =
      options.pollIntervalSeconds ?? DEFAULT_POLL_INTERVAL_SECONDS;
    const deadline = Date.now() + timeoutSeconds * 1000;

    while (true) {
      const status = await this.readStatus();

      // oxlint-disable-next-line no-console
      console.log(JSON.stringify(status));

      const hasPermanentFailure =
        status.failedOperationCount > 0 ||
        (status.activeOperationCount === 0 &&
          status.queueDepth === 0 &&
          (status.missingFieldStateCount > 0 ||
            status.unhealthyFieldStateCount > 0));

      if (hasPermanentFailure && options.failOnUnhealthy) {
        throw new Error(
          `Phone-search index is unhealthy: missingFieldStates=${status.missingFieldStateCount}, unhealthyFieldStates=${status.unhealthyFieldStateCount}, failedOperations=${status.failedOperationCount}`,
        );
      }

      if (status.activeOperationCount === 0 && status.queueDepth === 0) {
        return;
      }

      if (!options.wait) {
        if (options.failOnUnhealthy) {
          throw new Error(
            `Phone-search index has ${status.activeOperationCount} active operation(s) and queue depth ${status.queueDepth}`,
          );
        }
        return;
      }

      if (Date.now() >= deadline) {
        throw new Error(
          `Timed out waiting for ${status.activeOperationCount} phone-search index operation(s) and queue depth ${status.queueDepth}`,
        );
      }

      if (pollIntervalSeconds > 0) {
        await new Promise((resolve) =>
          setTimeout(resolve, pollIntervalSeconds * 1000),
        );
      }
    }
  }

  private async readStatus(): Promise<PhoneSearchIndexStatus> {
    const [availability] = (await this.dataSource.query(
      `SELECT
         to_regclass('core."phoneSearchFieldState"') IS NOT NULL AS "fieldStateAvailable",
         to_regclass('core."phoneSearchIndexOperation"') IS NOT NULL AS "operationAvailable"`,
    )) as Array<{
      fieldStateAvailable: boolean;
      operationAvailable: boolean;
    }>;

    if (
      !availability?.fieldStateAvailable ||
      !availability.operationAvailable
    ) {
      throw new Error(
        'Phone-search index tables are unavailable; the instance upgrade has not completed',
      );
    }

    const [status] = (await this.dataSource.query(
      `WITH expected_fields AS (
         SELECT workspace.id AS "workspaceId", object.id AS "objectMetadataId", field.id AS "fieldMetadataId"
           FROM core.workspace workspace
           JOIN core."objectMetadata" object
             ON object."workspaceId" = workspace.id
            AND object."nameSingular" = 'person'
            AND object."isActive" = true
           JOIN core."fieldMetadata" field
             ON field."workspaceId" = workspace.id
            AND field."objectMetadataId" = object.id
            AND field.type = 'PHONES'
            AND field."isActive" = true
          WHERE workspace."deletedAt" IS NULL
            AND workspace."activationStatus"::text IN ('CREATED', 'ACTIVE', 'SUSPENDED')
       )
       SELECT
         (SELECT count(*) FROM expected_fields) AS "expectedFieldCount",
         (SELECT count(*)
            FROM expected_fields expected
            LEFT JOIN core."phoneSearchFieldState" state
              ON state."workspaceId" = expected."workspaceId"
             AND state."objectMetadataId" = expected."objectMetadataId"
             AND state."fieldMetadataId" = expected."fieldMetadataId"
           WHERE state.id IS NULL) AS "missingFieldStateCount",
         (SELECT count(*)
            FROM expected_fields expected
            JOIN core."phoneSearchFieldState" state
              ON state."workspaceId" = expected."workspaceId"
             AND state."objectMetadataId" = expected."objectMetadataId"
             AND state."fieldMetadataId" = expected."fieldMetadataId"
           WHERE state."syncStatus" <> 'READY'
              OR state."isQueryEnabled" IS NOT TRUE) AS "unhealthyFieldStateCount",
         (SELECT count(*)
            FROM core."phoneSearchIndexOperation"
           WHERE status IN ('PENDING', 'RUNNING', 'RETRYABLE')) AS "activeOperationCount",
         (SELECT count(*)
            FROM core."phoneSearchIndexOperation"
           WHERE status = 'FAILED') AS "failedOperationCount"`,
    )) as Array<Record<keyof PhoneSearchIndexStatus, string | number>>;

    if (!status) {
      throw new Error('Phone-search index status query returned no result');
    }

    const queueDepth = (await this.queue.getInFlightJobs()).length;

    return {
      expectedFieldCount: Number(status.expectedFieldCount),
      missingFieldStateCount: Number(status.missingFieldStateCount),
      unhealthyFieldStateCount: Number(status.unhealthyFieldStateCount),
      activeOperationCount: Number(status.activeOperationCount),
      failedOperationCount: Number(status.failedOperationCount),
      queueDepth,
    };
  }

  private parsePositiveInteger(value: string, flag: string): number {
    const parsed = Number(value);

    if (!Number.isSafeInteger(parsed) || parsed <= 0) {
      throw new Error(`${flag} must be a positive integer`);
    }

    return parsed;
  }
}
