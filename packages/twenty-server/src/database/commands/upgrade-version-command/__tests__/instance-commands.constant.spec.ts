import { AddListOperandsToViewFilterEnumFastInstanceCommand } from 'src/database/commands/upgrade-version-command/2-27/2-27-instance-command-fast-1785900200000-add-list-operands-to-view-filter-enum';
import { AddWorkspaceDeletionLifecycleFastInstanceCommand } from 'src/database/commands/upgrade-version-command/2-32/2-32-instance-command-fast-1789196612599-add-workspace-deletion-lifecycle';
import { AddMetadataDeleteForeignKeyIndexesSlowInstanceCommand } from 'src/database/commands/upgrade-version-command/2-32/2-32-instance-command-slow-1791540000000-add-metadata-delete-fk-indexes';
import { CreateSearchVectorBackfillJobTableSlowInstanceCommand } from 'src/database/commands/upgrade-version-command/2-32/2-32-instance-command-slow-1791957830595-create-search-vector-backfill-job-table';
import { INSTANCE_COMMANDS } from 'src/database/commands/upgrade-version-command/instance-commands.constant';
import { getRegisteredInstanceCommandMetadata } from 'src/engine/core-modules/upgrade/decorators/registered-instance-command.decorator';

describe('INSTANCE_COMMANDS', () => {
  it('registers the list operand command', () => {
    expect(INSTANCE_COMMANDS).toEqual(
      expect.arrayContaining([
        AddListOperandsToViewFilterEnumFastInstanceCommand,
      ]),
    );
  });

  it('registers the workspace deletion lifecycle command', () => {
    expect(INSTANCE_COMMANDS).toContain(
      AddWorkspaceDeletionLifecycleFastInstanceCommand,
    );
  });

  it('registers the metadata delete foreign key index command', () => {
    expect(INSTANCE_COMMANDS).toContain(
      AddMetadataDeleteForeignKeyIndexesSlowInstanceCommand,
    );
  });

  // The runner orders fast before slow within a version, so this must be a slow command newer
  // than the one already applied on prod, or the runner would skip it.
  it('runs the search vector backfill job table command after the metadata foreign key index command', () => {
    const backfillJobTable = getRegisteredInstanceCommandMetadata(
      CreateSearchVectorBackfillJobTableSlowInstanceCommand,
    );
    const foreignKeyIndexes = getRegisteredInstanceCommandMetadata(
      AddMetadataDeleteForeignKeyIndexesSlowInstanceCommand,
    );

    expect(INSTANCE_COMMANDS).toContain(
      CreateSearchVectorBackfillJobTableSlowInstanceCommand,
    );
    expect(backfillJobTable?.type).toBe('slow');
    expect(backfillJobTable?.version).toBe(foreignKeyIndexes?.version);
    expect(backfillJobTable?.timestamp).toBeGreaterThan(
      foreignKeyIndexes?.timestamp ?? Infinity,
    );
  });
});
