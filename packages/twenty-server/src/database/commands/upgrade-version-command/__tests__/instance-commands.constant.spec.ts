import { AddListOperandsToViewFilterEnumFastInstanceCommand } from 'src/database/commands/upgrade-version-command/2-25/2-25-instance-command-fast-1784967600000-add-list-operands-to-view-filter-enum';
import { RepairListOperandsOnAdvancedInstancesFastInstanceCommand } from 'src/database/commands/upgrade-version-command/2-27/2-27-instance-command-fast-1785900100000-repair-list-operands-on-advanced-instances';
import { INSTANCE_COMMANDS } from 'src/database/commands/upgrade-version-command/instance-commands.constant';

describe('INSTANCE_COMMANDS', () => {
  it('registers both the original and advanced-instance list operand commands', () => {
    expect(INSTANCE_COMMANDS).toEqual(
      expect.arrayContaining([
        AddListOperandsToViewFilterEnumFastInstanceCommand,
        RepairListOperandsOnAdvancedInstancesFastInstanceCommand,
      ]),
    );
  });
});
