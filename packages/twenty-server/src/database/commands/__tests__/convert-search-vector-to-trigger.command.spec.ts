import { type WorkspaceIteratorService } from 'src/database/commands/command-runners/workspace-iterator.service';
import { ConvertSearchVectorToTriggerCommand } from 'src/database/commands/convert-search-vector-to-trigger.command';
import { type SearchVectorTriggerConversionService } from 'src/engine/core-modules/search-vector-trigger/services/search-vector-trigger-conversion.service';

const WORKSPACE_ID = '20202020-0000-0000-0000-000000000001';

describe('ConvertSearchVectorToTriggerCommand', () => {
  let command: ConvertSearchVectorToTriggerCommand;
  let convertWorkspaceMock: jest.Mock;

  beforeEach(() => {
    jest.clearAllMocks();

    convertWorkspaceMock = jest.fn().mockResolvedValue({
      status: 'dryRun',
      tables: [{ tableName: 'person', status: 'dryRun', mismatchCount: 0 }],
    });

    command = new ConvertSearchVectorToTriggerCommand(
      {} as WorkspaceIteratorService,
      {
        convertWorkspace: convertWorkspaceMock,
      } as unknown as SearchVectorTriggerConversionService,
    );
  });

  it('should check the workspace without converting when run with --dry-run', async () => {
    await command.runOnWorkspace({
      workspaceId: WORKSPACE_ID,
      options: { dryRun: true },
      index: 0,
      total: 1,
    });

    expect(convertWorkspaceMock).toHaveBeenCalledWith({
      workspaceId: WORKSPACE_ID,
      dryRun: true,
      repair: false,
    });
  });

  it('should convert when run without --dry-run', async () => {
    await command.runOnWorkspace({
      workspaceId: WORKSPACE_ID,
      options: {},
      index: 0,
      total: 1,
    });

    expect(convertWorkspaceMock).toHaveBeenCalledWith({
      workspaceId: WORKSPACE_ID,
      dryRun: false,
      repair: false,
    });
  });

  it('should pass --repair through to the conversion', async () => {
    await command.runOnWorkspace({
      workspaceId: WORKSPACE_ID,
      options: { repair: true } as never,
      index: 0,
      total: 1,
    });

    expect(convertWorkspaceMock).toHaveBeenCalledWith({
      workspaceId: WORKSPACE_ID,
      dryRun: false,
      repair: true,
    });
  });

  it('should refuse to run without an explicit workspace id', async () => {
    const iterate = jest.fn();
    const commandWithIterator = new ConvertSearchVectorToTriggerCommand(
      {
        iterate,
        listenToShutdownSignals: jest.fn(),
      } as unknown as WorkspaceIteratorService,
      {
        convertWorkspace: convertWorkspaceMock,
      } as unknown as SearchVectorTriggerConversionService,
    );

    await expect(commandWithIterator.run([], { dryRun: true })).rejects.toThrow(
      'Pass at least one workspace with -w.',
    );

    expect(iterate).not.toHaveBeenCalled();
    expect(convertWorkspaceMock).not.toHaveBeenCalled();
  });

  it('should iterate only the given workspaces when -w is passed', async () => {
    const iterate = jest.fn().mockResolvedValue({ interrupted: false });
    const commandWithIterator = new ConvertSearchVectorToTriggerCommand(
      {
        iterate,
        listenToShutdownSignals: jest.fn(),
      } as unknown as WorkspaceIteratorService,
      {
        convertWorkspace: convertWorkspaceMock,
      } as unknown as SearchVectorTriggerConversionService,
    );

    await commandWithIterator.run([], {
      dryRun: true,
      workspaceId: new Set([WORKSPACE_ID]),
    });

    expect(iterate).toHaveBeenCalledWith(
      expect.objectContaining({ workspaceIds: [WORKSPACE_ID] }),
    );
  });
});
