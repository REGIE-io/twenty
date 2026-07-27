import { type QueryRunner } from 'typeorm';

import { RegisteredInstanceCommand } from 'src/engine/core-modules/upgrade/decorators/registered-instance-command.decorator';
import { type FastInstanceCommand } from 'src/engine/core-modules/upgrade/interfaces/fast-instance-command.interface';

@RegisteredInstanceCommand('2.15.0', 1784967600000)
export class AddListOperandsToViewFilterEnumFastInstanceCommand implements FastInstanceCommand {
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
