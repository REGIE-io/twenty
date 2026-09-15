import { BackfillRegieE2eWorkspaceQuarantineCommand } from 'src/engine/workspace-manager/workspace-cleaner/commands/backfill-regie-e2e-workspace-quarantine.command';
import { type RegieE2eWorkspaceQuarantineBackfillWorkspaceService } from 'src/engine/workspace-manager/workspace-cleaner/services/regie-e2e-workspace-quarantine-backfill.workspace-service';

describe('BackfillRegieE2eWorkspaceQuarantineCommand', () => {
  const makeCommand = () => {
    const backfill = { run: jest.fn().mockResolvedValue({ candidates: [] }) };
    const command = new BackfillRegieE2eWorkspaceQuarantineCommand(
      backfill as unknown as RegieE2eWorkspaceQuarantineBackfillWorkspaceService,
    );

    return { command, backfill };
  };

  it('parses a comma-separated exact-account selection', () => {
    const { command } = makeCommand();

    expect(command.parseOrganizationIds('org_e2e_one, org_e2e_two')).toEqual([
      'org_e2e_one',
      'org_e2e_two',
    ]);
  });

  it('runs limited mode as a dry run when --apply is omitted', async () => {
    const { command, backfill } = makeCommand();

    await command.run([], { organizationIds: ['org_e2e_one'] });

    expect(backfill.run).toHaveBeenCalledWith({
      mode: 'limited',
      apply: false,
      organizationIds: ['org_e2e_one'],
    });
  });

  it('requires an explicit selection and passes explicit all/apply mode', async () => {
    const { command, backfill } = makeCommand();

    await expect(command.run([], {})).rejects.toThrow(
      'Choose --organization-ids for a limited run or --all',
    );
    await command.run([], { all: true, apply: true });
    expect(backfill.run).toHaveBeenLastCalledWith({
      mode: 'all',
      apply: true,
      organizationIds: undefined,
    });
  });
});
