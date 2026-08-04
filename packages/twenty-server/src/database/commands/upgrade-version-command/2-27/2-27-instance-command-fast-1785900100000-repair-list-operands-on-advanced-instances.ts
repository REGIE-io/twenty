import { type QueryRunner } from 'typeorm';

import { RegisteredInstanceCommand } from 'src/engine/core-modules/upgrade/decorators/registered-instance-command.decorator';
import { type FastInstanceCommand } from 'src/engine/core-modules/upgrade/interfaces/fast-instance-command.interface';

// The original 2.25 command shipped without being added to INSTANCE_COMMANDS.
// Instances whose migration cursor has passed 2.25 will not revisit it after
// registration, so repeat its idempotent statements at the current cursor.
@RegisteredInstanceCommand('2.27.0', 1785900100000)
export class RepairListOperandsOnAdvancedInstancesFastInstanceCommand implements FastInstanceCommand {
  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TYPE "core"."viewFilter_operand_enum" ADD VALUE IF NOT EXISTS 'IS_IN_LIST'`,
    );
    await queryRunner.query(
      `ALTER TYPE "core"."viewFilter_operand_enum" ADD VALUE IF NOT EXISTS 'IS_NOT_IN_LIST'`,
    );
  }

  // PostgreSQL enum values cannot be removed safely while preserving rows that
  // may use them, so rollback intentionally leaves the compatible superset.
  public async down(_queryRunner: QueryRunner): Promise<void> {}
}
