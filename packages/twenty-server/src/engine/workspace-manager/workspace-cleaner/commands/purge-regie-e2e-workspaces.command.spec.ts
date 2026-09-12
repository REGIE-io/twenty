import { PurgeRegieE2eWorkspacesCommand } from 'src/engine/workspace-manager/workspace-cleaner/commands/purge-regie-e2e-workspaces.command';
import { type RegieE2eWorkspaceSweeperService } from 'src/engine/workspace-manager/workspace-cleaner/services/regie-e2e-workspace-sweeper.service';

jest.mock(
  'src/engine/workspace-manager/workspace-cleaner/services/regie-e2e-workspace-sweeper.service',
  () => ({ RegieE2eWorkspaceSweeperService: class {} }),
);

describe('PurgeRegieE2eWorkspacesCommand', () => {
  it('runs exactly one guarded sweeper batch', async () => {
    const regieE2eWorkspaceSweeperService = {
      purgeQuarantinedWorkspaces: jest.fn().mockResolvedValue(4),
    };
    const command = new PurgeRegieE2eWorkspacesCommand(
      regieE2eWorkspaceSweeperService as unknown as RegieE2eWorkspaceSweeperService,
    );

    await command.run();

    expect(
      regieE2eWorkspaceSweeperService.purgeQuarantinedWorkspaces,
    ).toHaveBeenCalledTimes(1);
  });
});
