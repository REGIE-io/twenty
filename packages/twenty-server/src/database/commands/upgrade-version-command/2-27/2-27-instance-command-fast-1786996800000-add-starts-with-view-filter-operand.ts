import { type QueryRunner } from 'typeorm';

import { RegisteredInstanceCommand } from 'src/engine/core-modules/upgrade/decorators/registered-instance-command.decorator';
import { type FastInstanceCommand } from 'src/engine/core-modules/upgrade/interfaces/fast-instance-command.interface';

// This must be stamped at the current REGIE version. A 2.25 command would sit
// behind the instance-command cursor on existing deployments and never run.
@RegisteredInstanceCommand('2.27.0', 1786996800000)
export class AddStartsWithViewFilterOperandFastInstanceCommand
  implements FastInstanceCommand
{
  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TYPE "core"."viewFilter_operand_enum" ADD VALUE IF NOT EXISTS 'STARTS_WITH'`,
    );
  }

  // PostgreSQL enum values cannot be removed safely while preserving rows that
  // may use them, so rollback intentionally leaves the compatible superset.
  public async down(_queryRunner: QueryRunner): Promise<void> {}
}
