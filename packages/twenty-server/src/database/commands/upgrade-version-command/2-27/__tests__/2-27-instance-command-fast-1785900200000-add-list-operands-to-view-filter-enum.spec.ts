import { type QueryRunner } from 'typeorm';

import { AddListOperandsToViewFilterEnumFastInstanceCommand } from 'src/database/commands/upgrade-version-command/2-27/2-27-instance-command-fast-1785900200000-add-list-operands-to-view-filter-enum';

describe('AddListOperandsToViewFilterEnumFastInstanceCommand', () => {
  it('adds both list operands idempotently and leaves rollback as a no-op', async () => {
    const query = jest.fn().mockResolvedValue(undefined);
    const queryRunner = { query } as unknown as QueryRunner;
    const command = new AddListOperandsToViewFilterEnumFastInstanceCommand();

    await command.up(queryRunner);

    expect(query).toHaveBeenNthCalledWith(
      1,
      `ALTER TYPE "core"."viewFilter_operand_enum" ADD VALUE IF NOT EXISTS 'IS_IN_LIST'`,
    );
    expect(query).toHaveBeenNthCalledWith(
      2,
      `ALTER TYPE "core"."viewFilter_operand_enum" ADD VALUE IF NOT EXISTS 'IS_NOT_IN_LIST'`,
    );

    await command.down(queryRunner);
    expect(query).toHaveBeenCalledTimes(2);
  });
});
