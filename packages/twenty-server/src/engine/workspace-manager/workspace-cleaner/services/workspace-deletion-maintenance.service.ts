import { Injectable } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';

import { type DataSource, type EntityManager } from 'typeorm';

export type WorkspaceDeletionMaintenanceTimeouts = {
  statementTimeoutMs: number;
  lockTimeoutMs: number;
  clientTimeoutMs?: number;
};

type PgConnectionParameters = { query_timeout?: number };
type PgDatabaseConnection = {
  query_timeout?: number;
  connectionParameters?: PgConnectionParameters;
};
type QueryRunnerWithPgConnection = ReturnType<
  DataSource['createQueryRunner']
> & {
  databaseConnection?: PgDatabaseConnection;
};

@Injectable()
export class WorkspaceDeletionMaintenanceService {
  constructor(@InjectDataSource() private readonly dataSource: DataSource) {}

  async runInTransaction<T>(
    timeouts: WorkspaceDeletionMaintenanceTimeouts,
    operation: (manager: EntityManager) => Promise<T>,
  ): Promise<T> {
    const clientTimeoutMs =
      timeouts.clientTimeoutMs ?? timeouts.statementTimeoutMs + 5_000;

    if (clientTimeoutMs <= timeouts.statementTimeoutMs) {
      throw new Error('client timeout must exceed statement timeout');
    }

    const queryRunner =
      this.dataSource.createQueryRunner() as QueryRunnerWithPgConnection;
    let transactionStarted = false;
    let originalQueryTimeout: number | undefined;
    let originalClientTimeout: number | undefined;
    const connectionParameters =
      queryRunner.databaseConnection?.connectionParameters;

    await queryRunner.connect();
    const connectedParameters =
      queryRunner.databaseConnection?.connectionParameters ??
      connectionParameters;
    const databaseConnection = queryRunner.databaseConnection;

    if (databaseConnection !== undefined) {
      originalQueryTimeout = databaseConnection.query_timeout;
      databaseConnection.query_timeout = clientTimeoutMs;
    }

    if (connectedParameters !== undefined) {
      originalClientTimeout = connectedParameters.query_timeout;
      connectedParameters.query_timeout = clientTimeoutMs;
    }
    try {
      await queryRunner.startTransaction();
      transactionStarted = true;
      await queryRunner.query(
        `SELECT set_config('statement_timeout', $1, true)`,
        [`${timeouts.statementTimeoutMs}ms`],
      );
      await queryRunner.query(`SELECT set_config('lock_timeout', $1, true)`, [
        `${timeouts.lockTimeoutMs}ms`,
      ]);

      const result = await operation(queryRunner.manager);

      await queryRunner.commitTransaction();

      return result;
    } catch (error) {
      if (transactionStarted) {
        await queryRunner.rollbackTransaction();
      }
      throw error;
    } finally {
      if (databaseConnection !== undefined) {
        databaseConnection.query_timeout = originalQueryTimeout;
      }
      if (connectedParameters !== undefined) {
        connectedParameters.query_timeout = originalClientTimeout;
      }
      await queryRunner.release();
    }
  }
}
