import { type QueryRunner } from 'typeorm';

import { RegisteredInstanceCommand } from 'src/engine/core-modules/upgrade/decorators/registered-instance-command.decorator';
import { type FastInstanceCommand } from 'src/engine/core-modules/upgrade/interfaces/fast-instance-command.interface';

// Stamped at the current version, not the one this was written for. A command's
// version and timestamp decide where it runs in the upgrade sequence, and a 2.25
// stamp puts it behind every step this instance has already applied: it would
// never execute, and once registered it becomes the most recently recorded
// instance command at a low sequence index — which drives the upgrade-aware
// entity metadata cursor backwards and hands newly provisioned workspaces a
// cursor pointing at an instance command. It had never run anywhere, so there is
// no history tied to the old name.
@RegisteredInstanceCommand('2.27.0', 1785900200000)
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
