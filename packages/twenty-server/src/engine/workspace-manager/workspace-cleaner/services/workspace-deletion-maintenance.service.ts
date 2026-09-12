import { Injectable } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';

import { type DataSource, type EntityManager } from 'typeorm';

export type WorkspaceDeletionMaintenanceTimeouts = {
  statementTimeoutMs: number;
  lockTimeoutMs: number;
};

@Injectable()
export class WorkspaceDeletionMaintenanceService {
  constructor(@InjectDataSource() private readonly dataSource: DataSource) {}

  async runInTransaction<T>(
    timeouts: WorkspaceDeletionMaintenanceTimeouts,
    operation: (manager: EntityManager) => Promise<T>,
  ): Promise<T> {
    const queryRunner = this.dataSource.createQueryRunner();
    let transactionStarted = false;

    await queryRunner.connect();
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
      await queryRunner.release();
    }
  }
}
