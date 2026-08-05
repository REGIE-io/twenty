import { AddListOperandsToViewFilterEnumFastInstanceCommand } from 'src/database/commands/upgrade-version-command/2-27/2-27-instance-command-fast-1785900200000-add-list-operands-to-view-filter-enum';
import { INSTANCE_COMMANDS } from 'src/database/commands/upgrade-version-command/instance-commands.constant';

describe('INSTANCE_COMMANDS', () => {
  it('registers the list operand command', () => {
    expect(INSTANCE_COMMANDS).toEqual(
      expect.arrayContaining([
        AddListOperandsToViewFilterEnumFastInstanceCommand,
      ]),
    );
  });
});
