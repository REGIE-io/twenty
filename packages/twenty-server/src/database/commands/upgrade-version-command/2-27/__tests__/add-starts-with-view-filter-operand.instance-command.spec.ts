import { type QueryRunner } from 'typeorm';

import { AddStartsWithViewFilterOperandFastInstanceCommand } from 'src/database/commands/upgrade-version-command/2-27/2-27-instance-command-fast-1786996800000-add-starts-with-view-filter-operand';

describe('AddStartsWithViewFilterOperandFastInstanceCommand', () => {
  let command: AddStartsWithViewFilterOperandFastInstanceCommand;

  beforeEach(() => {
    command = new AddStartsWithViewFilterOperandFastInstanceCommand();
  });

  it('adds STARTS_WITH to the view filter operand enum', async () => {
    const query = jest.fn().mockResolvedValue(undefined);
    const queryRunner = { query } as unknown as QueryRunner;

    await command.up(queryRunner);

    expect(query).toHaveBeenCalledWith(
      `ALTER TYPE "core"."viewFilter_operand_enum" ADD VALUE IF NOT EXISTS 'STARTS_WITH'`,
    );
  });

  it('keeps the compatible enum superset on rollback', async () => {
    const query = jest.fn().mockResolvedValue(undefined);
    const queryRunner = { query } as unknown as QueryRunner;

    await command.down(queryRunner);

    expect(query).not.toHaveBeenCalled();
  });
});
